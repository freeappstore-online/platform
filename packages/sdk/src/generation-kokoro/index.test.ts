import { describe, expect, it, vi } from 'vitest';
import type { ContributeOptions, Generation, GenerationJob } from '../generation.js';
import { contributeKokoro, KokoroRunner, KokoroSkip, kokoroProblem } from './index.js';
import type { WorkerReply, WorkerRequest } from './shared.js';

const encoder: AudioEncoderConfig = {
  codec: 'mp4a.40.2',
  sampleRate: 24_000,
  numberOfChannels: 1,
  bitrate: 40_000,
};
const job = (over: Partial<GenerationJob> = {}): GenerationJob => ({
  id: 'j1',
  setId: 's1',
  key: 'book/0',
  input: { text: 'One. Two.' },
  model: 'kokoro',
  modelVersion: 'v1.0',
  params: { voice: 'af_heart' },
  formats: ['audio/mp4'],
  maxBytes: 1_000_000,
  leaseToken: 'lease',
  leaseExpiresAt: Date.now() + 15 * 60_000,
  ...over,
});

/** A stand-in for the app's worker: records requests, replies with `reply(request)`. */
function fakeWorker(reply: (req: WorkerRequest, send: (m: WorkerReply) => void) => void) {
  const target = new EventTarget();
  const requests: WorkerRequest[] = [];
  const send = (data: WorkerReply) =>
    queueMicrotask(() => target.dispatchEvent(new MessageEvent('message', { data })));
  const worker = Object.assign(target, {
    postMessage: (req: WorkerRequest) => {
      requests.push(req);
      reply(req, send);
    },
    terminate: vi.fn(),
  }) as unknown as Worker;
  return { worker, requests };
}

type Segments = (WorkerReply & { type: 'done' })['segments'];
const narrates = (segments: Segments = [[0, 4, 0, 1]], bytes = 3) =>
  fakeWorker((req, send) => {
    if (req.type !== 'narrate') return;
    send({ type: 'loading', progress: 0.5 });
    send({ type: 'progress', id: req.id, done: 1, total: 2, chars: 4 });
    const file = new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' });
    send({ type: 'done', id: req.id, file, segments });
  });

describe('kokoroProblem', () => {
  it('accepts Kokoro v1.0 sets for audio/mp4 with voice and speed', () => {
    expect(kokoroProblem(job())).toBeNull();
    expect(kokoroProblem(job({ params: { voice: 'bf_emma', speed: 1.1 } }), encoder)).toBeNull();
  });

  it('refuses anything it would not generate exactly', () => {
    expect(kokoroProblem(job({ modelVersion: 'v0.19' }))).toBe('model kokoro v0.19');
    expect(kokoroProblem(job({ model: 'piper' }))).toBe('model piper v1.0');
    expect(kokoroProblem(job({ formats: ['audio/ogg', 'audio/wav'] }))).toBe('no audio/mp4 format');
    expect(kokoroProblem(job({ params: { voice: 'af_heart', pitch: 2 } }))).toBe(
      'unknown params pitch',
    );
    expect(kokoroProblem(job({ params: {} }))).toBe('no voice');
    expect(kokoroProblem(job({ params: { voice: 'af_heart', speed: '2' } }))).toBe('invalid speed');
    expect(kokoroProblem(job({ params: { voice: 'af_heart', speed: 0 } }))).toBe('invalid speed');
  });

  it('refuses a job whose audio or sentence timings would be too large', () => {
    const text = 'A word. '.repeat(2000); // 2,000 sentences; 16,000 chars ≈ 1,143 s ≈ 5.7 MB at 40 kbps
    expect(kokoroProblem(job({ input: { text }, maxBytes: 2_000_000 }), encoder)).toBe(
      'audio would exceed maxBytes',
    );
    expect(kokoroProblem(job({ input: { text }, maxBytes: 25_000_000 }), encoder)).toBe(
      'sentence timings would exceed 64 KB',
    );
    // Without the encoder (a set, not a claimed job) the size is not checked
    expect(kokoroProblem(job({ input: { text }, maxBytes: 1 }))).toBeNull();
  });
});

describe('KokoroRunner', () => {
  it('narrates the claimed input with the job’s voice and speed and reports progress', async () => {
    const { worker, requests } = narrates();
    const runner = new KokoroRunner({ createWorker: () => worker, encoder, device: 'wasm' });
    const onLoading = vi.fn();
    const onProgress = vi.fn();
    const result = await runner.generate(job({ params: { voice: 'am_adam', speed: 1.2 } }), {
      onLoading,
      onProgress,
    });
    expect(requests).toEqual([
      {
        type: 'narrate',
        id: 1,
        text: 'One. Two.',
        voice: 'am_adam',
        speed: 1.2,
        config: encoder,
        device: 'wasm',
      },
    ]);
    expect(onLoading).toHaveBeenCalledWith(0.5);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ sentence: 1, sentences: 2, chars: 4, totalChars: 9 }),
    );
    expect(result.meta).toEqual({ segments: [[0, 4, 0, 1]] });
    expect(result.file.type).toBe('audio/mp4');
  });

  it('loads the model on request, reporting the download', async () => {
    const { worker, requests } = fakeWorker((req, send) => {
      if (req.type !== 'load') return;
      send({ type: 'loading', progress: 0.25 });
      send({ type: 'loaded', id: req.id });
    });
    const runner = new KokoroRunner({ createWorker: () => worker, encoder, device: 'webgpu' });
    const onLoading = vi.fn();
    await runner.load(onLoading);
    expect(requests).toEqual([{ type: 'load', id: 1, device: 'webgpu' }]);
    expect(onLoading).toHaveBeenCalledWith(0.25);

    const failing = fakeWorker((req, send) => {
      if (req.type === 'load') send({ type: 'error', id: req.id, message: 'offline', skip: false });
    });
    const broken = new KokoroRunner({
      createWorker: () => failing.worker,
      encoder,
      device: 'wasm',
    });
    await expect(broken.load()).rejects.toThrow('offline');
  });

  it('skips a job it can’t do without starting the worker', async () => {
    const createWorker = vi.fn();
    const runner = new KokoroRunner({ createWorker, encoder, device: 'wasm' });
    await expect(runner.generate(job({ formats: ['audio/ogg'] }))).rejects.toBeInstanceOf(
      KokoroSkip,
    );
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('skips when the worker finds the voice unknown, or the result is too large', async () => {
    const unknown = fakeWorker((req, send) => {
      if (req.type === 'narrate')
        send({ type: 'error', id: req.id, message: 'unknown voice xx', skip: true });
    });
    const runner = new KokoroRunner({
      createWorker: () => unknown.worker,
      encoder,
      device: 'wasm',
    });
    await expect(runner.generate(job())).rejects.toThrow(KokoroSkip);
    // 'One. Two.' is estimated at ~3.5 KB of audio; this worker returns 10 KB
    const big = narrates(undefined, 10_000);
    const small = new KokoroRunner({ createWorker: () => big.worker, encoder, device: 'wasm' });
    await expect(small.generate(job({ maxBytes: 5_000 }))).rejects.toThrow(
      'audio exceeds maxBytes',
    );
    const many = narrates(
      Array.from({ length: 3000 }, () => [99999, 100000, 99999.999, 99999.999]),
    );
    const timed = new KokoroRunner({ createWorker: () => many.worker, encoder, device: 'wasm' });
    await expect(timed.generate(job())).rejects.toThrow('sentence timings exceed 64 KB');
  });

  it('fails on a worker error and cancels on abort', async () => {
    const failing = fakeWorker((req, send) => {
      if (req.type === 'narrate') send({ type: 'error', id: req.id, message: 'boom', skip: false });
    });
    const runner = new KokoroRunner({
      createWorker: () => failing.worker,
      encoder,
      device: 'wasm',
    });
    const err = await runner.generate(job()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KokoroSkip);

    const silent = fakeWorker(() => {});
    const quiet = new KokoroRunner({ createWorker: () => silent.worker, encoder, device: 'wasm' });
    const controller = new AbortController();
    const pending = quiet.generate(job(), { signal: controller.signal });
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    expect(silent.requests.at(-1)).toEqual({ type: 'cancel' });
    quiet.dispose();
    expect(silent.worker.terminate).toHaveBeenCalled();
  });
});

describe('contributeKokoro', () => {
  /** `contribute` as the SDK runs it, over these claims */
  function generation(claims: GenerationJob[]) {
    const submitted: string[] = [];
    const contribute = vi.fn(async (opts: ContributeOptions) => {
      for (;;) {
        const claimed = claims.shift();
        if (!claimed) return { submitted: 0, stopped: 'no-work' as const };
        expect(opts.models).toEqual([{ model: 'kokoro', modelVersion: 'v1.0' }]);
        opts.onProgress?.({ stage: 'generating', job: claimed, submitted: 0 });
        await opts.generate(claimed);
        submitted.push(claimed.id);
        opts.onProgress?.({ stage: 'submitted', job: claimed, submitted: 1 });
      }
    });
    return { gen: { contribute } as unknown as Generation, contribute, submitted };
  }

  it('submits what it can, skips what it can’t, until there is no work', async () => {
    const { worker } = narrates();
    const runner = new KokoroRunner({ createWorker: () => worker, encoder, device: 'wasm' });
    const { gen, contribute, submitted } = generation([
      job({ id: 'a' }),
      job({ id: 'b', params: { voice: 'af_heart', tone: 'warm' } }),
      job({ id: 'c' }),
    ]);
    const events: string[] = [];
    const result = await contributeKokoro(gen, {
      runner,
      setId: 's1',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(`${e.type}${'job' in e ? `:${e.job.id}` : ''}`),
    });
    expect(result).toEqual({ submitted: 2, stopped: 'no-work' });
    expect(submitted).toEqual(['a', 'c']);
    expect(contribute).toHaveBeenCalledTimes(2);
    expect(contribute.mock.calls[0]![0].setId).toBe('s1');
    expect(events).toEqual([
      'claimed:a',
      'loading',
      'progress:a',
      'submitted:a',
      'claimed:b',
      'skipped:b',
      'claimed:c',
      'loading',
      'progress:c',
      'submitted:c',
    ]);
  });

  it('stops on abort and rethrows other errors', async () => {
    const silent = fakeWorker(() => {});
    const runner = new KokoroRunner({ createWorker: () => silent.worker, encoder, device: 'wasm' });
    const controller = new AbortController();
    const { gen } = generation([job()]);
    const running = contributeKokoro(gen, {
      runner,
      signal: controller.signal,
      onEvent: (e) => e.type === 'claimed' && controller.abort(),
    });
    expect(await running).toEqual({ submitted: 0, stopped: 'aborted' });

    const broken = {
      contribute: vi.fn().mockRejectedValue(new Error('403')),
    } as unknown as Generation;
    await expect(
      contributeKokoro(broken, { runner, signal: new AbortController().signal }),
    ).rejects.toThrow('403');
  });
});
