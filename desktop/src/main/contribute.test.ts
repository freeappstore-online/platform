import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WHEN, OFF } from './conditions.js';
import { Contribute, type ContributeHost, contributeStatus, type Reading } from './contribute.js';
import {
  clientHeaders,
  deleteDeviceToken,
  loadDeviceToken,
  pairDevice,
  saveDeviceToken,
} from './device.js';
import {
  clearHistory,
  endReason,
  type HistoryItem,
  INTERRUPTED,
  keepAudio,
  loadHistory,
  readAudio,
  saveHistory,
  saveRecord,
} from './history.js';
import { NativeRunner } from './kokoro.js';

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

/** A computer on AC power, cool and not in use: nothing holds Contribute (#830). */
const idle = { onBattery: false, battery: null, thermal: null, speedLimit: null, inUse: false };

/** Waits until `check` holds, letting the loop's promises run. */
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(check()).toBe(true);
}

afterEach(() => vi.unstubAllGlobals());

describe('Contribute', () => {
  let history: HistoryItem[] = [];
  /** What the host reads of this computer, in turn: start, each sentence, generated, end. */
  let readings: Reading[] = [];
  let spoken: { text: string; sid: number; speed: number; mandarin: boolean }[] = [];
  function setup(over: Partial<ContributeHost> = {}) {
    history = [];
    readings = [];
    spoken = [];
    // The TTS process speaks a second of samples per sentence (loading the model first); the
    // hidden window's encoder returns 8 bytes
    let loaded = false;
    const createRunner = (_encoder: unknown, rest: (ms: number) => number) =>
      new NativeRunner({
        rest,
        say: async (text, sid, speed, mandarin) => {
          spoken.push({ text, sid, speed, mandarin });
          const loadMs = loaded ? 0 : 700;
          loaded = true;
          return { samples: new Float32Array(24_000), sampleRate: 24_000, loadMs };
        },
        encode: () => ({
          write: () => {},
          finish: async () => new Uint8Array(8),
          cancel: () => {},
        }),
        bitrate: 32_000,
        dispose: () => {
          loaded = false;
        },
      });
    const host: ContributeHost = {
      token: () => 'ndev_x',
      optedIn: () => ['books'],
      mode: () => 'auto',
      when: () => DEFAULT_WHEN,
      machine: () => idle,
      modelReady: () => true,
      installModel: vi.fn(async () => {}),
      engine: async () => ({ encoder }),
      createRunner,
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
      { cpuMs: 2000, memMb: 900, foreground: true },
      { cpuMs: 3000, memMb: 700, foreground: true },
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
          synthMs: expect.any(Number),
          encodeMs: expect.any(Number),
          cpuMs: 3500,
          peakMemMb: 900,
          chargingStart: true,
          chargingEnd: false,
          thermalStart: 'nominal',
          thermalEnd: 'fair',
          bytes: 8,
          durationMs: 2400,
          uploadMs: expect.any(Number),
        }),
      }),
    ]);
    expect(host.keepAudio).toHaveBeenCalledWith(
      'books',
      'j1',
      expect.objectContaining({
        meta: {
          segments: [
            [0, 4, 0, 1],
            [5, 9, 1.4, 2.4],
          ],
        },
      }),
    );
    // Spoken by the phones' engine, a sentence at a time, with af_heart's speaker id
    expect(spoken).toEqual([
      { text: 'One.', sid: 3, speed: 1, mandarin: false },
      { text: 'Two.', sid: 3, speed: 1, mandarin: false },
    ]);
    const sent = fetch.mock.calls.find(([url]) => url.endsWith('/events'))!;
    expect(JSON.parse(String(sent[1]!.body)).events).toEqual([
      { jobId: 'j1', ...history[0]!.record },
    ]);
    expect(contribute.state.apps).toEqual([
      { appId: 'books', oneliner: 'Free books', open: 3, problem: null },
      // Mandarin is spoken here as on the phones (#837)
      { appId: 'dialogue', oneliner: null, open: 3, problem: null },
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
    const paused = setup({ mode: () => 'off' }).contribute;
    paused.wake();
    await until(() => paused.state.status === 'off');
    expect(paused.state.message).toBe(OFF);

    const noModel = setup({ modelReady: () => false }).contribute;
    noModel.wake();
    await until(() => noModel.state.message === 'Download the voice model to start.');
    expect(noModel.state.model).toMatchObject({
      engine: 'Kokoro v1.0 (sherpa-onnx, CPU)',
      languages: 'English, Spanish, Mandarin',
      bytes: 349_886_476,
      ready: false,
    });

    const none = setup({ optedIn: () => [] }).contribute;
    none.wake();
    await until(() => none.state.message === 'Choose the apps to generate for.');
    for (const c of [paused, noModel, none]) c.stop();
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
      mode: () => (paused ? 'off' : 'auto'),
      engine: () =>
        new Promise((resolve) => {
          loaded = () => resolve({ encoder });
        }),
    });
    contribute.wake();
    await until(() => loaded !== null);
    paused = true;
    contribute.wake();
    loaded!();
    await until(() => contribute.state.status === 'off');
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/claim'))).toBe(false);
    contribute.stop();
  });

  it("records the run's last job as lease_cap when its lease ran out", async () => {
    const claims = [
      json({ job: { ...job, leaseExpiresAt: Date.now() - 1 } }),
      new Response(null, { status: 204 }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/generation/open'))
          return json({
            apps: [
              {
                appId: 'books',
                oneliner: null,
                sets: [kokoroSet('s1', { voice: 'af_heart' }, null)],
              },
            ],
          });
        if (url.endsWith('/claim')) return claims.shift()!;
        if (url.endsWith('/events')) return json({ recorded: 1 });
        return json({ submissions: [] });
      }),
    );
    const { contribute } = setup();
    contribute.wake();
    await until(() => history.length === 1 && contribute.state.status === 'idle');
    expect(history[0]).toMatchObject({
      jobId: 'j1',
      outcome: 'stopped',
      record: { reason: 'lease_cap' },
    });
    contribute.stop();
  });

  it('says so, and looks again later, when the hidden window closes before it reports', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ apps: [] })),
    );
    const { contribute } = setup({
      engine: async () => {
        throw new Error('the generating window closed');
      },
    });
    contribute.wake();
    await until(
      () => contribute.state.message === "Couldn't start generating: the generating window closed",
    );
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

  it('downloads the model only when asked, off the main thread, with its progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ apps: [] })),
    );
    let ready = false;
    const stages: unknown[] = [];
    const { contribute } = setup({
      modelReady: () => ready,
      installModel: async (progress) => {
        progress('download', 0.5);
        stages.push(contribute.state.model?.stage, contribute.state.model?.loading);
        progress('unpack', 0.25);
        stages.push(contribute.state.model?.stage, contribute.state.model?.loading);
        ready = true;
      },
      changed: () => {},
    });
    await contribute.downloadModel();
    expect(stages).toEqual(['download', 0.5, 'unpack', 0.25]);
    expect(contribute.state.model).toMatchObject({ ready: true, loading: null });
    contribute.stop();
  });

  it('puts the job in hand on the record as In progress, with its live detail (#838)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claims = [json({ job }), new Response(null, { status: 204 })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/generation/open'))
          return json({
            apps: [
              {
                appId: 'books',
                oneliner: null,
                sets: [kokoroSet('s1', { voice: 'af_heart' }, null)],
              },
            ],
          });
        if (url.endsWith('/claim')) return claims.shift()!;
        if (url.endsWith('/result')) return json({ submissionId: 'x', status: 'pending' }, 202);
        if (url.endsWith('/events')) return json({ recorded: 1 });
        return json({ submissions: [] });
      }),
    );
    // The second sentence waits, so the job is seen in hand
    const { contribute: held } = setup({
      createRunner: () =>
        new NativeRunner({
          say: async (text) => {
            if (text === 'Two.') await gate;
            return { samples: new Float32Array(24_000), sampleRate: 24_000, loadMs: 0 };
          },
          encode: () => ({
            write: () => {},
            finish: async () => new Uint8Array(8),
            cancel: () => {},
          }),
          bitrate: 32_000,
          dispose: () => {},
        }),
    });
    readings.push({ cpuMs: 100, foreground: true }, { cpuMs: 600, foreground: true });
    held.wake();
    await until(() => held.state.current?.sentence === 1);
    expect(history).toEqual([
      expect.objectContaining({ jobId: 'j1', outcome: 'in_progress', text: 'One. Two.' }),
    ]);
    expect(held.state.current).toMatchObject({
      appId: 'books',
      jobId: 'j1',
      key: 'book/0',
      at: history[0]!.at,
      sentence: 1,
      sentences: 2,
      cpuMs: 500,
      leaseExpiresAt: job.leaseExpiresAt,
      encoded: false,
    });
    release();
    await until(() => held.state.submitted === 1);
    // Ended in place: one item, no longer In progress
    expect(history.map((i) => i.outcome)).toEqual(['submitted']);
    held.stop();
  });

  it('a sign-out drops what the job in hand, its audio and a verdict refresh would still write (#848)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/generation/open'))
        return json({
          apps: [
            {
              appId: 'books',
              oneliner: null,
              sets: [kokoroSet('s1', { voice: 'af_heart' }, null)],
            },
          ],
        });
      if (url.endsWith('/claim')) return json({ job });
      if (url.endsWith('/events')) return json({ recorded: 1 });
      return json({ submissions: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const { host, contribute: held } = setup({
      createRunner: () =>
        new NativeRunner({
          say: async (text) => {
            if (text === 'Two.') await gate;
            return { samples: new Float32Array(24_000), sampleRate: 24_000, loadMs: 0 };
          },
          encode: () => ({
            write: () => {},
            finish: async () => new Uint8Array(8),
            cancel: () => {},
          }),
          bitrate: 32_000,
          dispose: () => {},
        }),
    });
    held.wake();
    await until(() => held.state.current?.sentence === 1);
    expect(history.map((i) => i.outcome)).toEqual(['in_progress']);
    // The sign-out clears the record (the app deletes the files), then the job in hand ends late
    history = [];
    held.reset();
    release();
    await until(() => held.state.status !== 'running');
    await new Promise((r) => setTimeout(r, 20));
    expect(history).toEqual([]);
    expect(host.keepAudio).not.toHaveBeenCalled();
    expect(held.state).toMatchObject({ current: null, apps: null, submitted: 0, message: null });
    // Looking for work names this app's version and kind (#833)
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({
      'X-FAS-App-Version': '0.1.2',
      'X-FAS-Client': 'desktop',
    });
    held.stop();
  });

  /** The stand-in API for #830: books has `jobs` to claim, in turn; it records what was claimed and sent. */
  function serve(jobs: (typeof job)[]) {
    const queue = [...jobs];
    const sent = { claims: 0, events: [] as { reason: string }[], uploads: 0, opens: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/generation/open')) {
          sent.opens++;
          return json({
            apps: [
              {
                appId: 'books',
                oneliner: null,
                sets: [kokoroSet('s1', { voice: 'af_heart' }, null)],
              },
            ],
          });
        }
        if (url.endsWith('/claim')) {
          sent.claims++;
          const next = queue.shift();
          return next ? json({ job: next }) : new Response(null, { status: 204 });
        }
        if (url.endsWith('/result')) {
          sent.uploads++;
          return json({ submissionId: 'x', status: 'pending' }, 202);
        }
        if (url.endsWith('/events')) {
          sent.events.push(...JSON.parse(String(init!.body)).events);
          return json({ recorded: 1 });
        }
        return json({ submissions: [] });
      }),
    );
    return sent;
  }
  const five = { ...job, input: { text: 'One. Two. Three. Four. Five.' } };

  it('stops a job under 80% when a condition fails between sentences, and gives it back (#830)', async () => {
    const sent = serve([job, { ...job, id: 'j2' }]);
    // Unplugged once the first of two sentences is spoken
    const { contribute } = setup({ machine: () => ({ ...idle, onBattery: spoken.length >= 1 }) });
    contribute.wake();
    await until(() => history[0]?.outcome === 'stopped' && contribute.state.status === 'paused');
    expect(contribute.state.message).toBe('On battery. It runs on AC power only.');
    expect(history[0]).toMatchObject({
      jobId: 'j1',
      reason: 'Paused: On battery. It runs on AC power only.',
      record: { reason: 'unplugged' },
    });
    await until(() => sent.events.length === 1);
    expect(sent.events[0]).toMatchObject({ jobId: 'j1', reason: 'unplugged' });
    expect([sent.claims, sent.uploads]).toEqual([1, 0]);
    contribute.stop();
  });

  it('finishes a job 80% done when a condition fails, then claims nothing more (#830)', async () => {
    const sent = serve([five, { ...five, id: 'j2' }]);
    // Hot once four of five sentences are spoken
    const { contribute } = setup({
      machine: () => ({ ...idle, thermal: spoken.length >= 4 ? 'serious' : 'nominal' }),
    });
    contribute.wake();
    await until(() => contribute.state.submitted === 1 && contribute.state.status === 'paused');
    expect(contribute.state.message).toBe('The computer is hot.');
    expect(history.map((i) => [i.jobId, i.outcome])).toEqual([['j1', 'submitted']]);
    expect(sent.claims).toBe(1);
    contribute.stop();
  });

  it('Off stops the job in hand however far it got, and nothing starts again (#830)', async () => {
    const sent = serve([five]);
    let mode: 'auto' | 'off' = 'auto';
    let off: Contribute | null = null;
    // Turned Off while the last sentence is being spoken
    off = setup({
      mode: () => mode,
      createRunner: () =>
        new NativeRunner({
          say: async (text) => {
            if (text === 'Five.') {
              mode = 'off';
              off!.wake();
            }
            return { samples: new Float32Array(24_000), sampleRate: 24_000, loadMs: 0 };
          },
          encode: () => ({
            write: () => {},
            finish: async () => new Uint8Array(8),
            cancel: () => {},
          }),
          bitrate: 32_000,
          dispose: () => {},
        }),
    }).contribute;
    off.wake();
    await until(() => history[0]?.outcome === 'stopped' && off.state.status === 'off');
    expect(off.state.message).toBe(OFF);
    expect(history[0]).toMatchObject({ record: { reason: 'user_stop' } });
    expect([sent.claims, sent.uploads]).toEqual([1, 0]);
    // Woken again (a setting, power), it still looks for nothing
    const opens = sent.opens;
    off.wake();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.opens).toBe(opens);
    expect(off.state.status).toBe('off');
    off.stop();
  });

  it('waits without looking for work while held, and says why (#830)', async () => {
    const sent = serve([job]);
    let machine = { ...idle, inUse: true };
    const { contribute } = setup({ machine: () => machine });
    contribute.wake();
    await until(() => contribute.state.status === 'paused');
    expect(contribute.state.message).toBe('Computer in use.');
    expect(sent.opens).toBe(0);
    // No longer in use: it runs
    machine = idle;
    contribute.wake();
    await until(() => contribute.state.submitted === 1);
    contribute.stop();
  });

  it('Run now runs once regardless of the conditions, then is Auto again and says why it waits (#830)', async () => {
    const sent = serve([job]);
    const { contribute } = setup({ machine: () => ({ ...idle, onBattery: true }) });
    contribute.wake();
    await until(() => contribute.state.status === 'paused');
    contribute.runNow();
    expect(contribute.state.runNow).toBe(true);
    await until(() => contribute.state.submitted === 1 && !contribute.state.runNow);
    await until(() => contribute.state.status === 'paused');
    expect(contribute.state.message).toBe('On battery. It runs on AC power only.');
    expect(sent.uploads).toBe(1);
    contribute.stop();
  });

  it('rests between sentences as the CPU setting says, longer while in use (#830)', () => {
    let when = DEFAULT_WHEN;
    let machine = idle;
    const { contribute } = setup({ when: () => when, machine: () => machine });
    expect(contribute.rest(1000)).toBe(250);
    when = { ...DEFAULT_WHEN, cpu: 'full' };
    expect(contribute.rest(1000)).toBe(0);
    when = { ...DEFAULT_WHEN, cpu: 'full', inUse: 'slower' };
    machine = { ...idle, inUse: true };
    expect(contribute.rest(1000)).toBe(1000);
  });

  it('describes itself in one tray line', () => {
    const state = new Contribute(setup().host).state;
    expect(contributeStatus(state)).toBe('Contribute: waiting');
    expect(contributeStatus({ ...state, status: 'off', message: OFF })).toBe('Contribute: off');
    expect(contributeStatus({ ...state, status: 'paused', message: 'Computer in use.' })).toBe(
      'Contribute: paused. Computer in use.',
    );
    const current = {
      appId: 'books',
      jobId: 'j',
      key: 'k',
      at: 0,
      sentence: 3,
      sentences: 40,
      charsPerSecond: 20,
      cpuMs: null,
      leaseExpiresAt: 0,
      encoded: false,
    };
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
    const headers = clientHeaders('0.4.0 (57, abc1234)');
    const token = await pairDevice({
      label: 'FreeAppStore desktop (Mac)',
      open,
      headers,
      api,
      pollMs: 1,
    });
    expect(token).toBe('ndev_new');
    expect(open).toHaveBeenCalledWith('https://api.test/ok');
    const start = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(start.label).toBe('FreeAppStore desktop (Mac)');
    expect(start.challenge).toMatch(/^[0-9a-f]{64}$/);
    // Pairing says which version this is (#833)
    for (const [, init] of fetch.mock.calls)
      expect(init.headers).toMatchObject({ 'X-FAS-App-Version': '0.4.0 (57, abc1234)' });
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
    await expect(pairDevice({ label: 'x', open: vi.fn(), headers: {}, api })).rejects.toThrow(
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

  it('deletes the history and every kept audio file on sign-out (#848)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-clear-'));
    try {
      saveHistory(dir, [{ appId: 'books', jobId: 'j1' } as HistoryItem]);
      keepAudio(dir, 'books', 'j1', new Uint8Array([1]), { segments: [] });
      expect(clearHistory(dir)).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
      expect(loadHistory(dir)).toEqual([]);
      expect(readAudio(dir, 'books', 'j1')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes an item left In progress by a quit as interrupted, and saves a record (#838, #843)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-history-'));
    try {
      const item = {
        appId: 'books',
        jobId: 'j1',
        key: 'book/0',
        at: 5,
        outcome: 'in_progress',
        reason: null,
        text: 'One.',
        chars: 4,
        record: { runner: 'desktop', reason: 'user_stop' },
        verdict: null,
      } as HistoryItem;
      saveHistory(dir, [item]);
      const [closed] = loadHistory(dir);
      expect(closed).toMatchObject({ outcome: 'stopped', reason: INTERRUPTED });
      keepAudio(dir, 'books', 'j1', new Uint8Array([1, 2]), { segments: [[0, 4, 0, 1]] });
      const target = join(dir, 'saved');
      saveRecord(dir, closed!, target);
      expect(JSON.parse(readFileSync(join(target, 'record.json'), 'utf8'))).toEqual({
        ...closed,
        meta: { segments: [[0, 4, 0, 1]] },
      });
      expect(new Uint8Array(readFileSync(join(target, 'audio.m4a')))).toEqual(
        new Uint8Array([1, 2]),
      );
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
