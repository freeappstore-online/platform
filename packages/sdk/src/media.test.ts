import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseRecordingType,
  exportRecording,
  mediaSupport,
  registerMediaBusyGuard,
  requestCapture,
  stopRecording,
  stopTracks,
} from './media.js';

const original = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  recorder: Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder'),
};
afterEach(() => {
  for (const [key, descriptor] of Object.entries({
    navigator: original.navigator,
    document: original.document,
    MediaRecorder: original.recorder,
  })) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  vi.useRealTimers();
});

describe('optional media lifecycle', () => {
  it('reports unsupported capture and mobile display capture', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'iPhone', mediaDevices: { getDisplayMedia: vi.fn() } },
    });
    expect(mediaSupport('microphone')).toMatchObject({ capture: false, reason: 'unsupported' });
    expect(mediaSupport('display')).toMatchObject({
      capture: false,
      reason: 'mobile-display-capture-unsupported',
    });
  });

  it('surfaces denied permission and stops a stream granted after cancellation', async () => {
    const controller = new AbortController();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('denied')) } },
    });
    await expect(requestCapture('microphone')).rejects.toThrow('denied');
    let resolve!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((done) => (resolve = done));
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => pending } },
    });
    const capture = requestCapture('microphone', controller.signal);
    controller.abort();
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await expect(capture).rejects.toMatchObject({ name: 'AbortError' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('negotiates a supported format, stops tracks and exposes a removable busy guard', () => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: { isTypeSupported: (type: string) => type === 'audio/webm' },
    });
    expect(chooseRecordingType(['audio/ogg', 'audio/webm'])).toBe('audio/webm');
    const stop = vi.fn();
    stopTracks({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    expect(stop).toHaveBeenCalledOnce();
    let guard: (() => boolean) | undefined;
    let removed = 0;
    let busy = false;
    const dispose = registerMediaBusyGuard(
      {
        addBusyGuard: (callback) => {
          guard = callback;
          return () => removed++;
        },
      },
      () => busy,
    );
    expect(guard?.()).toBe(false);
    busy = true;
    expect(guard?.()).toBe(true);
    dispose();
    expect(removed).toBe(1);
  });

  it('stops the recorder before stopping tracks', async () => {
    const order: string[] = [];
    const recorder = new EventTarget() as MediaRecorder;
    Object.defineProperty(recorder, 'state', { value: 'recording' });
    Object.defineProperty(recorder, 'stop', {
      value: () => {
        order.push('recorder');
        recorder.dispatchEvent(new Event('stop'));
      },
    });
    await stopRecording(recorder, {
      getTracks: () => [{ stop: () => order.push('track') }],
    } as unknown as MediaStream);
    expect(order).toEqual(['recorder', 'track']);
  });

  it('removes both temporary recorder listeners after repeated stops and synchronous errors', async () => {
    const recorder = new EventTarget() as MediaRecorder;
    const removeListener = vi.spyOn(recorder, 'removeEventListener');
    Object.defineProperty(recorder, 'state', { value: 'recording' });
    let throwOnStop = false;
    Object.defineProperty(recorder, 'stop', {
      value: () => {
        if (throwOnStop) throw new Error('stop failed');
        recorder.dispatchEvent(new Event('stop'));
      },
    });
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    for (let i = 0; i < 3; i++) await stopRecording(recorder, stream);
    throwOnStop = true;
    await stopRecording(recorder, stream);
    expect(removeListener).toHaveBeenCalledTimes(8);
    expect(removeListener).toHaveBeenCalledWith('stop', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('keeps download URLs alive through dispatch, then releases them idempotently', async () => {
    vi.useFakeTimers();
    const clicked = vi.fn();
    const removed = vi.fn();
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click: clicked,
      remove: removed,
    };
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { body: { appendChild: vi.fn() }, createElement: () => anchor },
    });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const result = await exportRecording(
      new Blob(['synthetic'], { type: 'audio/webm' }),
      'voice.webm',
    );
    expect(result).toMatchObject({ ok: true, method: 'downloaded', filename: 'voice.webm' });
    if (!result.ok) throw new Error('expected download result');
    expect(clicked).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    result.release();
    result.release();
    expect(revoke).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(0);
    expect(create).toHaveBeenCalledOnce();
    revoke.mockRestore();
    create.mockRestore();
  });

  it('distinguishes a cancelled share from a failed share and allows fallback on failure', async () => {
    if (typeof File === 'undefined') return;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { appendChild: vi.fn() },
        createElement: () => ({
          href: '',
          download: '',
          rel: '',
          style: { display: '' },
          click: vi.fn(),
          remove: vi.fn(),
        }),
      },
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:share-fallback');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('dismissed', 'AbortError'))
      .mockRejectedValueOnce(new Error('share failed'));
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { canShare: () => true, share },
    });
    const cancelled = await exportRecording(new Blob(['x']), 'voice.bin');
    expect(cancelled).toMatchObject({ ok: false, reason: 'cancelled' });
    const result = await exportRecording(new Blob(['x']), 'voice.bin');
    expect(result).toMatchObject({ ok: true, method: 'downloaded' });
  });

  it('falls back when the share capability probe throws', async () => {
    if (typeof File === 'undefined') return;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        canShare: () => {
          throw new Error('probe failed');
        },
        share: vi.fn(),
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { appendChild: vi.fn() },
        createElement: () => ({
          href: '',
          download: '',
          rel: '',
          style: {},
          click: vi.fn(),
          remove: vi.fn(),
        }),
      },
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe-fallback');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await expect(exportRecording(new Blob(['x']), 'voice.bin')).resolves.toMatchObject({
      ok: true,
      method: 'downloaded',
    });
  });

  it('removes a failed download anchor and revokes the created URL', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {},
      click: vi.fn(() => {
        throw new Error('click failed');
      }),
      remove: vi.fn(),
    };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { body: { appendChild: vi.fn() }, createElement: () => anchor },
    });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:failed-download');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await expect(exportRecording(new Blob(['x']), 'voice.bin')).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:failed-download');
    create.mockRestore();
    revoke.mockRestore();
  });
});
