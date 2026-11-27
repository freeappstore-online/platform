import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Contribute,
  type ContributeHost,
  contributeStatus,
  type Reading,
  RelayWorker,
} from './contribute.js';
import { deleteDeviceToken, loadDeviceToken, pairDevice, saveDeviceToken } from './device.js';
import {
  endReason,
  type HistoryItem,
  keepAudio,
  loadHistory,
  readAudio,
  saveHistory,
} from './history.js';

const api = 'https://api.test/v1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const encoder = { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 1, bitrate: 32_000 };
const kokoroSet = (setId: string, params: Record<string, unknown>, language: string | null) => ({
  setId,
  kind: 'tts',
  model: 'kokoro',
  modelVersion: 'v1.0',
  params,
  formats: ['audio/mp4'],
  maxBytes: 25_000_000,
  language,
  open: 3,
});
const job = {
  id: 'j1',
  setId: 's1',
  key: 'book/0',
  input: { text: 'One. Two.' },
  model: 'kokoro',
  modelVersion: 'v1.0',
  params: { voice: 'af_heart' },
  formats: ['audio/mp4'],
  maxBytes: 25_000_000,
  language: null,
  leaseToken: 'lease',
  leaseExpiresAt: Date.now() + 15 * 60_000,
};

/** Waits until `check` holds, letting the loop's promises run. */
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(check()).toBe(true);
}

afterEach(() => vi.unstubAllGlobals());

describe('RelayWorker', () => {
  it('posts to the hidden window and turns finished audio back into a Blob', async () => {
    const post = vi.fn();
    const relay = new RelayWorker(post);
    relay.postMessage({ type: 'load', id: 1 });
    relay.terminate();
    expect(post.mock.calls).toEqual([[{ type: 'load', id: 1 }], [{ type: 'terminate' }]]);
    const got: unknown[] = [];
    relay.addEventListener('message', (e) => got.push((e as MessageEvent).data));
    relay.receive({ type: 'done', file: new Uint8Array([1, 2, 3]).buffer });
    relay.receive({ type: 'progress' });
    const done = got[0] as { file: Blob };
    expect(done.file).toBeInstanceOf(Blob);
    expect([done.file.type, done.file.size]).toEqual(['audio/mp4', 3]);
    expect(got[1]).toEqual({ type: 'progress' });
  });
});

describe('Contribute', () => {
  let history: HistoryItem[] = [];
  /** What the host reads of this computer, in turn: start, each sentence, generated, end. */
  let readings: Reading[] = [];
  function setup(over: Partial<ContributeHost> = {}) {
    let relay: RelayWorker | null = null;
    history = [];
    readings = [];
    // The hidden window's worker: narrates any job in one sentence
    const createWorker = () => {
      relay = new RelayWorker((message) => {
        const msg = message as { type: string; id: number };
        if (msg.type !== 'narrate') return;
        queueMicrotask(() => {
          relay!.receive({ type: 'progress', id: msg.id, done: 1, total: 2, chars: 4 } as never);
          relay!.receive({
            type: 'done',
            id: msg.id,
            file: new Uint8Array(8).buffer,
            segments: [[0, 4, 0, 1]],
            timing: { loadMs: 700, synthMs: 500, encodeMs: 20 },
          } as never);
        });
      });
      return relay;
    };
    const host: ContributeHost = {
      token: () => 'ndev_x',
      optedIn: () => ['books'],
      paused: () => false,
      modelReady: () => true,
      setModelReady: vi.fn(),
      engine: async () => ({ encoder, device: 'wasm', downloaded: true }),
      createWorker,
      deleteModel: vi.fn(async () => {}),
      signedOut: vi.fn(),
      changed: vi.fn(),
      probe: () => readings.shift() ?? { foreground: false },
      context: () => ({ appVersion: '0.1.2', os: 'darwin 24.6.0', device: 'Apple M3 arm64' }),
      history: () => history,
      setHistory: (items) => {
        history = items;
      },
      keepAudio: vi.fn(async () => {}),
      ...over,
    };
    return { host, contribute: new Contribute(host, 'https://api.test', 60 * 60_000) };
  }

  it('looks for work with the device credential, generates and uploads, then waits', async () => {
    const claims = [json({ job }), new Response(null, { status: 204 })];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${api}/generation/open`)
        return json({
          apps: [
            {
              appId: 'books',
              oneliner: 'Free books',
              sets: [kokoroSet('s1', { voice: 'af_heart' }, null)],
            },
            {
              appId: 'dialogue',
              oneliner: null,
              sets: [kokoroSet('s2', { voice: 'zf_xiaobei' }, 'zh')],
            },
          ],
        });
      if (url.endsWith('/claim')) return claims.shift()!;
      if (url.endsWith('/jobs/j1/result') && init?.method === 'PUT')
        return json({ submissionId: 'x', status: 'pending' }, 202);
      if (url.endsWith('/events')) return json({ recorded: 1 });
      if (url.endsWith('/submissions'))
        return json({
          submissions: [
            {
              submissionId: 'x',
              jobId: 'j1',
              status: 'rejected',
              reason: 'too fast',
              durationMs: 1000,
              report: null,
            },
          ],
        });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    const { contribute, host } = setup();
    readings.push(
      { cpuMs: 1000, memMb: 300, charging: true, thermal: 'nominal', foreground: true },
      { memMb: 900, foreground: true },
      { memMb: 700, foreground: false },
      { cpuMs: 4500, memMb: 400, charging: false, thermal: 'fair', foreground: true },
    );
    contribute.wake();
    await until(() => contribute.state.submitted === 1 && contribute.state.status === 'idle');
    await until(() => history[0]?.verdict !== null && history.length > 0);
    // The attempt's record (#827): kept here with the verdict, and its numbers sent
    expect(history).toEqual([
      expect.objectContaining({
        appId: 'books',
        jobId: 'j1',
        outcome: 'submitted',
        text: 'One. Two.',
        verdict: {
          submissionId: 'x',
          status: 'rejected',
          reason: 'too fast',
          durationMs: 1000,
          report: null,
        },
        record: expect.objectContaining({
          runner: 'desktop',
          reason: 'submitted',
          appVersion: '0.1.2',
          device: 'Apple M3 arm64',
          background: true,
          loadMs: 700,
          synthMs: 500,
          encodeMs: 20,
          cpuMs: 3500,
          peakMemMb: 900,
          chargingStart: true,
          chargingEnd: false,
          thermalStart: 'nominal',
          thermalEnd: 'fair',
          bytes: 8,
          durationMs: 1000,
          rtf: 0.5,
          uploadMs: expect.any(Number),
        }),
      }),
    ]);
    expect(host.keepAudio).toHaveBeenCalledWith(
      'books',
      'j1',
      expect.objectContaining({ meta: { segments: [[0, 4, 0, 1]] } }),
    );
    const sent = fetch.mock.calls.find(([url]) => url.endsWith('/events'))!;
    expect(JSON.parse(String(sent[1]!.body)).events).toEqual([
      { jobId: 'j1', ...history[0]!.record },
    ]);
    expect(contribute.state.apps).toEqual([
      { appId: 'books', oneliner: 'Free books', open: 3, problem: null },
      {
        appId: 'dialogue',
        oneliner: null,
        open: 0,
        problem: 'language zh: this browser runner speaks English only',
      },
    ]);
    expect(contribute.state.message).toMatch(/^No more work for now/);
    const calls = fetch.mock.calls.map(([url, init]) => [init?.method ?? 'GET', url]);
    expect(calls).toEqual([
      ['GET', `${api}/generation/open`],
      ['POST', `${api}/apps/books/generation/claim`],
      ['PUT', `${api}/apps/books/generation/jobs/j1/result`],
      ['POST', `${api}/apps/books/generation/events`],
      ['POST', `${api}/apps/books/generation/claim`],
      ['GET', `${api}/apps/books/generation/submissions`],
    ]);
    for (const [, init] of fetch.mock.calls)
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ndev_x');
    // Only the runnable set of the opted-in app is claimed
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body)).setId).toBe('s1');
    contribute.stop();

    // Good / Not good for the upload (#831), with the device credential, kept with the item
    const report = { good: false, note: 'mumbles', at: 1 };
    fetch.mockImplementationOnce(async () => json({ report }));
    expect(await contribute.report('books', 'j1', false, 'mumbles')).toEqual(report);
    const [url, init] = fetch.mock.calls.at(-1)!;
    expect(url).toBe(`${api}/apps/books/generation/submissions/x/report`);
    expect(init?.method).toBe('PUT');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ndev_x');
    expect(JSON.parse(String(init!.body))).toEqual({ good: false, note: 'mumbles' });
    expect(history[0]!.verdict!.report).toEqual(report);
    await expect(contribute.report('books', 'nope', true, '')).rejects.toThrow(/Nothing uploaded/);
  });

  it('says why it is not generating: paused, no model, no apps chosen, no AAC', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ apps: [] })),
    );
    const paused = setup({ paused: () => true }).contribute;
    paused.wake();
    await until(() => paused.state.status === 'paused');

    const noModel = setup({ modelReady: () => false }).contribute;
    noModel.wake();
    await until(() => noModel.state.message === 'Download the voice model to start.');
    expect(noModel.state.model).toMatchObject({ device: 'wasm', bytes: 92_361_116, ready: false });

    const none = setup({ optedIn: () => [] }).contribute;
    none.wake();
    await until(() => none.state.message === 'Choose the apps to generate for.');

    const noAac = setup({
      engine: async () => ({ encoder: null, device: 'wasm', downloaded: false }),
    }).contribute;
    noAac.wake();
    await until(() => noAac.state.encoder === false);
    for (const c of [paused, noModel, none, noAac]) c.stop();
  });

  it('claims nothing when paused while it was still looking for work', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/generation/open')
        ? json({
            apps: [
              {
                appId: 'books',
                oneliner: null,
                sets: [kokoroSet('s1', { voice: 'af_heart' }, null)],
              },
            ],
          })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetch);
    let paused = false;
    let loaded: (() => void) | null = null;
    const { contribute } = setup({
      paused: () => paused,
      engine: () =>
        new Promise((resolve) => {
          loaded = () => resolve({ encoder, device: 'wasm', downloaded: true });
        }),
    });
    contribute.wake();
    await until(() => loaded !== null);
    paused = true;
    contribute.wake();
    loaded!();
    await until(() => contribute.state.status === 'paused');
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/claim'))).toBe(false);
    contribute.stop();
  });

  it('hands a refused device credential back to the app', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    const signedOut = vi.fn();
    const { contribute } = setup({ signedOut });
    contribute.wake();
    await until(() => signedOut.mock.calls.length === 1);
    contribute.stop();
  });

  it('downloads the model only when asked, through the hidden window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ apps: [] })),
    );
    let ready = false;
    const posted: unknown[] = [];
    const createWorker = () => {
      const relay: RelayWorker = new RelayWorker((message) => {
        posted.push(message);
        const msg = message as { type: string; id: number };
        if (msg.type === 'load')
          queueMicrotask(() => {
            relay.receive({ type: 'loading', progress: 0.5 } as never);
            relay.receive({ type: 'loaded', id: msg.id } as never);
          });
      });
      return relay;
    };
    const setModelReady = vi.fn((r: boolean) => {
      ready = r;
    });
    const { contribute } = setup({
      modelReady: () => ready,
      setModelReady,
      createWorker,
      engine: async () => ({ encoder, device: 'webgpu', downloaded: ready }),
    });
    await contribute.downloadModel();
    expect(setModelReady).toHaveBeenCalledWith(true);
    expect(posted).toEqual([{ type: 'load', id: 1, device: 'webgpu' }, { type: 'terminate' }]);
    expect(contribute.state.model).toMatchObject({ ready: true, loading: null });
    contribute.stop();
  });

  it('describes itself in one tray line', () => {
    const state = new Contribute(setup().host).state;
    expect(contributeStatus(state)).toBe('Contribute: idle');
    expect(contributeStatus({ ...state, status: 'paused' })).toBe('Contribute: paused');
    const current = { appId: 'books', key: 'k', sentence: 3, sentences: 40, charsPerSecond: 20 };
    expect(contributeStatus({ ...state, status: 'running', current })).toBe(
      'Contribute: books, sentence 3 of 40',
    );
  });
});

describe('device pairing', () => {
  it('opens the approval page and redeems the approval for a device token', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ id: 'p1', authorizationUrl: 'https://api.test/ok', expiresIn: 600 }),
      )
      .mockResolvedValueOnce(json({ pending: true }, 202))
      .mockResolvedValueOnce(json({ token: 'ndev_new', deviceId: 'd1' }));
    vi.stubGlobal('fetch', fetch);
    const open = vi.fn();
    const token = await pairDevice({ label: 'FreeAppStore desktop (Mac)', open, api, pollMs: 1 });
    expect(token).toBe('ndev_new');
    expect(open).toHaveBeenCalledWith('https://api.test/ok');
    const start = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(start.label).toBe('FreeAppStore desktop (Mac)');
    expect(start.challenge).toMatch(/^[0-9a-f]{64}$/);
    const complete = JSON.parse(fetch.mock.calls[2]![1].body);
    expect(complete.id).toBe('p1');
    // The verifier hashes to the challenge sent first
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(complete.verifier).digest('hex')).toBe(start.challenge);
  });

  it('fails with the server’s reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'Try connecting again later.' }, 429)),
    );
    await expect(pairDevice({ label: 'x', open: vi.fn(), api })).rejects.toThrow(
      'Try connecting again later.',
    );
  });

  it('keeps the credential in userData, readable only by the user', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-device-'));
    try {
      expect(loadDeviceToken(dir)).toBeNull();
      saveDeviceToken(dir, 'ndev_abc');
      expect(loadDeviceToken(dir)).toBe('ndev_abc');
      expect(statSync(join(dir, 'device-token')).mode & 0o777).toBe(0o600);
      deleteDeviceToken(dir);
      expect(loadDeviceToken(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('history (#827)', () => {
  it('keeps the latest 20 attempts’ audio, the newest first, and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-history-'));
    try {
      const item = (jobId: string) =>
        ({
          appId: 'books',
          jobId,
          key: jobId,
          at: 0,
          outcome: 'submitted',
          reason: null,
          text: '',
          chars: 0,
          record: { runner: 'desktop', reason: 'submitted' },
          verdict: null,
        }) as HistoryItem;
      let items: HistoryItem[] = [];
      for (let i = 0; i < 22; i++) {
        keepAudio(dir, 'books', `j${i}`, new Uint8Array([i]), { segments: [] });
        items = saveHistory(dir, [item(`j${i}`), ...items]);
      }
      expect(loadHistory(dir)).toHaveLength(22);
      expect(readAudio(dir, 'books', 'j21')).toEqual({
        audio: new Uint8Array([21]),
        meta: { segments: [] },
      });
      expect(readAudio(dir, 'books', 'j2')).not.toBeNull();
      expect(readAudio(dir, 'books', 'j1')).toBeNull();
      expect(readAudio(dir, 'books', 'j0')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps how a job ended to the #813 reasons', () => {
    expect(endReason('submitted', null)).toBe('submitted');
    expect(endReason('skipped', 'audio exceeds maxBytes')).toBe('too_large');
    expect(endReason('skipped', 'unknown voice zz')).toBe('unsupported');
    expect(endReason('stopped', 'the lease ran out before it finished')).toBe('lease_cap');
    expect(endReason('stopped', 'stopped before it finished')).toBe('user_stop');
    expect(endReason('failed', 'Failed to fetch', new TypeError('Failed to fetch'))).toBe(
      'network',
    );
    expect(endReason('failed', 'worker crashed')).toBe('other');
  });
});
