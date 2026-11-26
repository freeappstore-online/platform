import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContributeOptions, Generation, GenerationJob } from '../generation.js';
import {
  contributeKokoro,
  contributeKokoroApps,
  KokoroRunner,
  KokoroSkip,
  kokoroEncoder,
  kokoroProblem,
} from './index.js';
import type { WorkerReply, WorkerRequest } from './shared.js';

const encoder: AudioEncoderConfig = {
  codec: 'mp4a.40.2',
  sampleRate: 24_000,
  numberOfChannels: 1,
  bitrate: 32_000,
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
  language: null,
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
    const timing = { loadMs: 900, synthMs: 2000, encodeMs: 40 };
    send({ type: 'done', id: req.id, file, segments, timing });
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

  it('skips sets that are not English, with the reason (platform#812)', () => {
    expect(kokoroProblem(job({ language: 'en' }))).toBeNull();
    expect(kokoroProblem(job({ language: 'en-GB', params: { voice: 'bf_emma' } }))).toBeNull();
    // Dialogue's Mandarin sets: kokoro v1.0, language zh, voices zf_xiaobei / zm_yunxi
    const mandarin = { input: { text: '请问，洗手间在哪里？' }, params: { voice: 'zf_xiaobei' } };
    expect(kokoroProblem(job({ ...mandarin, language: 'zh' }), encoder)).toBe(
      'language zh: this browser runner speaks English only',
    );
    expect(kokoroProblem(job({ ...mandarin, language: 'zh-Hans' }))).toBe(
      'language zh-Hans: this browser runner speaks English only',
    );
    expect(kokoroProblem(job({ ...mandarin, language: null }))).toBe(
      'voice zf_xiaobei is not English: this browser runner speaks English only',
    );
    expect(kokoroProblem(job({ params: { voice: 'zm_yunxi' }, language: 'en' }))).toBe(
      'voice zm_yunxi is not English: this browser runner speaks English only',
    );
    expect(kokoroProblem(job({ params: { voice: 'ef_dora' }, language: 'es' }))).toBe(
      'language es: this browser runner speaks English only',
    );
  });

  it('refuses a job whose audio or sentence timings would be too large', () => {
    const text = 'A word. '.repeat(2000); // 2,000 sentences; 16,000 chars ≈ 1,143 s ≈ 4.6 MB at 32 kbps
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

describe('kokoroEncoder', () => {
  const browser = (supported: (c: AudioEncoderConfig) => boolean) => {
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('AudioEncoder', {
      isConfigSupported: async (config: AudioEncoderConfig) => ({ supported: supported(config) }),
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('encodes speech at 32 kbps mono AAC 24 kHz (platform#798)', async () => {
    browser(() => true);
    expect(await kokoroEncoder()).toEqual({
      codec: 'mp4a.40.2',
      sampleRate: 24_000,
      numberOfChannels: 1,
      bitrate: 32_000,
    });
  });

  it('falls back to 48 kHz, then a higher bitrate, else none', async () => {
    browser((c) => c.sampleRate === 48_000);
    expect(await kokoroEncoder()).toEqual(
      expect.objectContaining({ sampleRate: 48_000, bitrate: 32_000 }),
    );
    browser((c) => (c.bitrate ?? 0) > 64_000);
    expect(await kokoroEncoder()).toEqual(
      expect.objectContaining({ sampleRate: 48_000, bitrate: 96_000 }),
    );
    browser(() => false);
    expect(await kokoroEncoder()).toBeNull();
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
    // The worker's stage times (#827)
    expect(result.timing).toEqual({ loadMs: 900, synthMs: 2000, encodeMs: 40 });
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
  function generation(claims: GenerationJob[], submitted: string[] = []) {
    const renew = vi.fn(async () => {});
    const contribute = vi.fn(async (opts: ContributeOptions) => {
      let n = 0;
      for (;;) {
        if (n >= (opts.limit ?? Infinity)) return { submitted: n, stopped: 'limit' as const };
        const claimed = claims.shift();
        if (!claimed) return { submitted: n, stopped: 'no-work' as const };
        expect(opts.models).toEqual([{ model: 'kokoro', modelVersion: 'v1.0' }]);
        opts.onProgress?.({ stage: 'generating', job: claimed, submitted: n });
        await opts.generate(claimed, { renew });
        submitted.push(claimed.id);
        opts.onProgress?.({ stage: 'submitted', job: claimed, submitted: ++n });
      }
    });
    return { gen: { contribute } as unknown as Generation, contribute, submitted, renew };
  }

  it('submits what it can, skips what it can’t, until there is no work', async () => {
    const { worker } = narrates();
    const runner = new KokoroRunner({ createWorker: () => worker, encoder, device: 'wasm' });
    const { gen, contribute, submitted, renew } = generation([
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
    expect(contribute).toHaveBeenCalledTimes(4); // one job per call, then no work
    expect(contribute.mock.calls[0]![0].setId).toBe('s1');
    // Each message from the worker (loading, progress) renews the lease, timers or not
    expect(renew).toHaveBeenCalledTimes(4);
    expect(events).toEqual([
      'claimed:a',
      'loading',
      'progress:a',
      'generated:a',
      'submitted:a',
      'claimed:b',
      'skipped:b',
      'claimed:c',
      'loading',
      'progress:c',
      'generated:c',
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

  describe('contributeKokoroApps', () => {
    const appsOf = (gens: Record<string, Generation>, setIds = ['s1']) =>
      Object.entries(gens).map(([appId, generation]) => ({ appId, generation, setIds }));

    it('takes one job from each app in turn, dropping apps with no work', async () => {
      const { worker } = narrates();
      const runner = new KokoroRunner({ createWorker: () => worker, encoder, device: 'wasm' });
      const order: string[] = [];
      const books = generation([job({ id: 'b1' }), job({ id: 'b2' }), job({ id: 'b3' })], order);
      const radio = generation([job({ id: 'r1' })], order);
      const events: string[] = [];
      const result = await contributeKokoroApps({
        runner,
        signal: new AbortController().signal,
        apps: () => appsOf({ books: books.gen, radio: radio.gen }),
        onEvent: (e, appId) => e.type === 'submitted' && events.push(`${appId}:${e.job.id}`),
      });
      expect(result).toEqual({ submitted: 4, stopped: 'no-work' });
      expect(order).toEqual(['b1', 'r1', 'b2', 'b3']);
      expect(events).toEqual(['books:b1', 'radio:r1', 'books:b2', 'books:b3']);
    });

    it('tries an app’s sets in order and leaves out an app turned off mid-run', async () => {
      const { worker } = narrates();
      const runner = new KokoroRunner({ createWorker: () => worker, encoder, device: 'wasm' });
      const books = generation([job({ id: 'b1' }), job({ id: 'b2' })]);
      const radio = generation([job({ id: 'r1' }), job({ id: 'r2' })]);
      let on = ['books', 'radio'];
      const result = await contributeKokoroApps({
        runner,
        signal: new AbortController().signal,
        apps: () =>
          appsOf({ books: books.gen, radio: radio.gen }, ['s1', 's2']).filter((a) =>
            on.includes(a.appId),
          ),
        onEvent: (e, appId) => {
          if (e.type === 'submitted' && appId === 'radio') on = ['books'];
        },
      });
      expect(result).toEqual({ submitted: 3, stopped: 'no-work' });
      expect(radio.submitted).toEqual(['r1']);
      expect(books.submitted).toEqual(['b1', 'b2']);
      // books: s1 gave both jobs, then s1 and s2 had none
      expect(books.contribute.mock.calls.map(([o]) => o.setId)).toEqual(['s1', 's1', 's1', 's2']);
    });

    it('reports a failed job and goes on; a skip or failure takes the app out of the run', async () => {
      const { worker } = narrates();
      const runner = new KokoroRunner({ createWorker: () => worker, encoder, device: 'wasm' });
      const failing = {
        contribute: vi.fn(async (opts: ContributeOptions) => {
          opts.onProgress?.({ stage: 'generating', job: job({ id: 'f1' }), submitted: 0 });
          throw new TypeError('Failed to fetch');
        }),
      } as unknown as Generation;
      const skipping = generation([job({ id: 'x1', params: { voice: 'zf_xiaobei' } }), job()]);
      const fine = generation([job({ id: 'ok1' })]);
      const events: string[] = [];
      const result = await contributeKokoroApps({
        runner,
        signal: new AbortController().signal,
        apps: () => appsOf({ failing, skipping: skipping.gen, fine: fine.gen }),
        onEvent: (e, appId) =>
          ['failed', 'skipped', 'submitted'].includes(e.type) &&
          events.push(`${e.type}:${appId}:${'job' in e ? e.job.id : ''}`),
      });
      expect(result).toEqual({ submitted: 1, stopped: 'no-work' });
      expect(events).toEqual(['failed:failing:f1', 'skipped:skipping:x1', 'submitted:fine:ok1']);
    });

    it('throws a claim that failed and a lost sign-in; stops on abort', async () => {
      const { worker } = narrates();
      const runner = new KokoroRunner({ createWorker: () => worker, encoder, device: 'wasm' });
      const claimFails = {
        contribute: vi.fn().mockRejectedValue(new Error('503 down')),
      } as unknown as Generation;
      const signal = new AbortController().signal;
      await expect(
        contributeKokoroApps({ runner, signal, apps: () => appsOf({ a: claimFails }) }),
      ).rejects.toThrow('503 down');
      const signedOut = {
        contribute: vi.fn(async (opts: ContributeOptions) => {
          opts.onProgress?.({ stage: 'generating', job: job(), submitted: 0 });
          throw new Error('Not signed in.');
        }),
      } as unknown as Generation;
      await expect(
        contributeKokoroApps({ runner, signal, apps: () => appsOf({ a: signedOut }) }),
      ).rejects.toThrow('Not signed in.');

      const controller = new AbortController();
      const endless = generation(Array.from({ length: 10 }, (_, i) => job({ id: `j${i}` })));
      const result = await contributeKokoroApps({
        runner,
        signal: controller.signal,
        apps: () => appsOf({ a: endless.gen }),
        onEvent: (e) => e.type === 'submitted' && e.submitted === 2 && controller.abort(),
      });
      expect(result).toEqual({ submitted: 2, stopped: 'aborted' });
    });
  });
});
