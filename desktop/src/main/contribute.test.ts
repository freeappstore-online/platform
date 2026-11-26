import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Contribute, type ContributeHost, contributeStatus, RelayWorker } from './contribute.js';
import { deleteDeviceToken, loadDeviceToken, pairDevice, saveDeviceToken } from './device.js';

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
  function setup(over: Partial<ContributeHost> = {}) {
    let relay: RelayWorker | null = null;
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
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    const { contribute } = setup();
    contribute.wake();
    await until(() => contribute.state.submitted === 1 && contribute.state.status === 'idle');
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
      ['POST', `${api}/apps/books/generation/claim`],
    ]);
    for (const [, init] of fetch.mock.calls)
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ndev_x');
    // Only the runnable set of the opted-in app is claimed
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body)).setId).toBe('s1');
    contribute.stop();
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
