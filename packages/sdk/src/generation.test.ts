import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.js';
import { Generation, type GenerationJob, type GenerationSubmission } from './generation.js';

const base = 'https://api.example/v1/apps/books/generation';
const models = [{ model: 'kokoro', modelVersion: '1.0' }];
const job = (id: string, leaseExpiresAt = Date.now() + 900_000): GenerationJob => ({
  id,
  setId: 's1',
  key: `ch1:${id}`,
  input: { text: 'Hello.' },
  model: 'kokoro',
  modelVersion: '1.0',
  params: { voice: 'af' },
  formats: ['audio/ogg'],
  maxBytes: 1_000_000,
  leaseToken: `lease-${id}`,
  leaseExpiresAt,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const client = (token: string | null = 'tok') =>
  new Generation('books', 'https://api.example', {
    token,
    handleUnauthorized: vi.fn(),
  } as unknown as Auth);
function mockFetch(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe('generation SDK', () => {
  it('owner creates a set, adds jobs, withdraws and blocks with the session', async () => {
    const set = {
      id: 's1',
      kind: 'tts',
      ...models[0],
      params: {},
      formats: ['audio/ogg'],
      maxBytes: 1,
      replicas: 1,
    };
    const fetch = mockFetch(
      json({ set }, 201),
      json({ jobs: [{ id: 'j1', key: 'a', status: 'open' }] }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    );
    const gen = client();
    const { id: _id, ...opts } = set;
    expect(await gen.createSet(opts as never)).toEqual(set);
    expect(await gen.addJobs('s1', [{ key: 'a', input: { text: 'Hi' } }])).toEqual([
      { id: 'j1', key: 'a', status: 'open' },
    ]);
    await gen.withdraw('j1');
    await gen.blockContributor('u 2');
    expect(fetch.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['POST', `${base}/sets`],
      ['POST', `${base}/sets/s1/jobs`],
      ['DELETE', `${base}/artifacts/j1`],
      ['POST', `${base}/contributors/u%202/block`],
    ]);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      jobs: [{ key: 'a', input: { text: 'Hi' } }],
    });
    expect(fetch.mock.calls[0]![1].headers.Authorization).toBe('Bearer tok');
  });

  it('owner lists sets and pages jobs', async () => {
    const sets = [{ id: 's1', counts: { jobs: 2, open: 1 } }];
    const page = { jobs: [{ id: 'j1', key: 'a' }], nextCursor: 'a' };
    const fetch = mockFetch(json({ sets }), json(page), json({ jobs: [], nextCursor: null }));
    const gen = client();
    expect(await gen.listSets()).toEqual(sets);
    expect(await gen.listJobs('s 1', { status: 'accepted', cursor: 'ch1:a', limit: 2 })).toEqual(
      page,
    );
    await gen.listJobs('s1');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${base}/sets`,
      `${base}/sets/s%201/jobs?status=accepted&cursor=ch1%3Aa&limit=2`,
      `${base}/sets/s1/jobs`,
    ]);
    expect(fetch.mock.calls[0]![1].headers.Authorization).toBe('Bearer tok');
  });

  it('owner reads one job with its whole input', async () => {
    const one = { id: 'j 1', key: 'a', input: { text: 'Long.' } };
    const fetch = mockFetch(json({ job: one }));
    expect(await client().getJob('s1', 'j 1')).toEqual(one);
    expect(fetch.mock.calls[0]![0]).toBe(`${base}/sets/s1/jobs/j%201`);
  });

  it('openWork returns this app’s claimable sets', async () => {
    const set = { setId: 's1', kind: 'tts', ...models[0], params: {}, open: 3 };
    const fetch = mockFetch(
      json({ apps: [{ appId: 'books', oneliner: null, sets: [set] }] }),
      json({ apps: [] }),
      new Response('blocked from contributing to this app', { status: 403 }),
    );
    expect(await client().openWork()).toEqual([set]);
    expect(await client().openWork()).toEqual([]);
    await expect(client().openWork()).rejects.toThrow('blocked');
    expect(fetch.mock.calls[0]![0]).toBe('https://api.example/v1/generation/open?appId=books');
  });

  it('surfaces a 409 for a key re-added with different input', async () => {
    mockFetch(new Response('key a exists with a different input', { status: 409 }));
    await expect(client().addJobs('s1', [{ key: 'a', input: { text: 'x' } }])).rejects.toThrow(
      'different input',
    );
  });

  it('claim returns the job, or null on 204', async () => {
    const fetch = mockFetch(json({ job: job('j1') }), new Response(null, { status: 204 }));
    const gen = client();
    expect((await gen.claim({ setId: 's1', models }))?.id).toBe('j1');
    expect(await gen.claim({ models })).toBeNull();
    expect(fetch.mock.calls[0]![0]).toBe(`${base}/claim`);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ setId: 's1', models });
  });

  it('claim, submit and extendLease send one X-Runner-Id per browser install', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, v),
    });
    const fetch = mockFetch(
      json({ job: job('j1') }),
      json({ leaseExpiresAt: 1 }),
      json({ submissionId: 'sub1', status: 'pending' }, 202),
    );
    const gen = client();
    const j = (await gen.claim({ models }))!;
    await gen.extendLease(j);
    await gen.submit(j, new Blob(['ogg'], { type: 'audio/ogg' }));
    const ids = fetch.mock.calls.map(([, init]) => init.headers['X-Runner-Id']);
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(ids).toEqual([ids[0], ids[0], ids[0]]);
    expect(stored.get('fas:generation-runner')).toBe(ids[0]);
    // Storage that throws (private mode, blocked): one id for the page's lifetime.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    const f2 = mockFetch(json({ job: job('j2') }), json({ job: job('j3') }));
    await gen.claim({ models });
    await client().claim({ models });
    const [a, b] = f2.mock.calls.map(([, init]) => init.headers['X-Runner-Id']);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(b).toBe(a);
  });

  it('submit sends multipart file + meta with the lease token and attestation', async () => {
    const fetch = mockFetch(json({ submissionId: 'sub1', status: 'pending' }, 202));
    const file = new Blob(['ogg'], { type: 'audio/ogg' });
    const result = await client().submit(job('j1'), file, {
      meta: { t: [0, 1] },
      attestation: 'att',
    });
    expect(result).toEqual({ submissionId: 'sub1', status: 'pending' });
    const [url, init] = fetch.mock.calls[0]!;
    expect([init.method, url]).toEqual(['PUT', `${base}/jobs/j1/result`]);
    expect(init.headers).toMatchObject({ 'X-Lease-Token': 'lease-j1', 'X-Attestation': 'att' });
    expect(init.headers['Content-Type']).toBeUndefined();
    const body = init.body as FormData;
    expect(await (body.get('file') as Blob).text()).toBe('ogg');
    expect(JSON.parse(body.get('meta') as string)).toEqual({ t: [0, 1] });
  });

  it('recordAttempts posts attempt records (#827)', async () => {
    const fetch = mockFetch(json({ recorded: 1 }));
    const events = [{ jobId: 'j1', runner: 'browser', reason: 'submitted', wallMs: 1200 }] as const;
    expect(await client().recordAttempts([...events])).toBe(1);
    expect(fetch.mock.calls[0]![0]).toBe(`${base}/events`);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ events });
  });

  it('mySubmissions lists the caller’s submissions; signed out throws before fetching', async () => {
    const submissions = [
      {
        submissionId: 'sub1',
        jobId: 'j1',
        setId: 'set1',
        key: 'ch1',
        status: 'rejected',
        reason: 'asr mismatch',
        bytes: 3,
        contentType: 'audio/ogg',
        createdAt: 1,
        decidedAt: 2,
        wer: 0.6,
        durationMs: 1500,
        input: { text: 'Hello.' },
        artifact: null,
      },
      {
        submissionId: 'sub2',
        jobId: 'j2',
        setId: 'set1',
        key: 'ch2',
        status: 'accepted',
        reason: null,
        bytes: 3,
        contentType: 'audio/ogg',
        createdAt: 3,
        decidedAt: 4,
        wer: 0,
        durationMs: 2000,
        input: { text: 'World.' },
        artifact: { url: 'https://api/a/j2?v=1', metaUrl: 'https://api/a/j2/meta?v=1' },
      },
    ] satisfies GenerationSubmission[];
    const fetch = mockFetch(json({ submissions }));
    expect(await client().mySubmissions()).toEqual(submissions);
    expect(fetch.mock.calls[0]![0]).toBe(`${base}/submissions`);
    await expect(client(null).claim({ models })).rejects.toThrow('Not signed in');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('contribute loops claim → generate → submit until there is no work', async () => {
    const fetch = mockFetch(
      json({ job: job('j1') }),
      json({ submissionId: 's1', status: 'pending' }, 202),
      json({ job: job('j2') }),
      json({ submissionId: 's2', status: 'pending' }, 202),
      new Response(null, { status: 204 }),
    );
    const generate = vi.fn(async (j: GenerationJob) => ({
      file: new Blob([j.input.text]),
      meta: { id: j.id },
    }));
    const onProgress = vi.fn();
    expect(await client().contribute({ setId: 's1', models, generate, onProgress })).toEqual({
      submitted: 2,
      stopped: 'no-work',
    });
    expect(generate.mock.calls.map(([j]) => j.id)).toEqual(['j1', 'j2']);
    expect(onProgress.mock.calls.map(([e]) => [e.stage, e.job.id, e.submitted])).toEqual([
      ['generating', 'j1', 0],
      ['submitted', 'j1', 1],
      ['generating', 'j2', 1],
      ['submitted', 'j2', 2],
    ]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('contribute abandons a job whose lease expired and stops on abort', async () => {
    let fetch = mockFetch(json({ job: job('j1', Date.now() - 1) }));
    const file = { file: new Blob(['x']) };
    expect(await client().contribute({ models, generate: async () => file })).toEqual({
      submitted: 0,
      stopped: 'lease-expired',
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    fetch = mockFetch(json({ job: job('j2') }));
    const generate = async () => {
      controller.abort();
      return file;
    };
    expect(await client().contribute({ models, generate, signal: controller.signal })).toEqual({
      submitted: 0,
      stopped: 'aborted',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('extendLease posts the lease token and updates the job; a 409 at the cap throws', async () => {
    const fetch = mockFetch(
      json({ leaseExpiresAt: 123 }),
      new Response('{"error":"the lease cannot be extended further"}', { status: 409 }),
    );
    const j = job('j1');
    expect(await client().extendLease(j)).toBe(123);
    expect(j.leaseExpiresAt).toBe(123);
    const [url, init] = fetch.mock.calls[0]!;
    expect([init.method, url]).toEqual(['POST', `${base}/jobs/j1/lease`]);
    expect(init.headers).toMatchObject({ 'X-Lease-Token': 'lease-j1' });
    await expect(client().extendLease(j)).rejects.toThrow('cannot be extended');
  });

  describe('contribute keeps a long job leased', () => {
    afterEach(() => vi.useRealTimers());
    const minutes = (n: number) => n * 60_000;

    it('extends within 5 minutes of expiry while generating, then submits', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const now = Date.now();
      const fetch = mockFetch(
        json({ job: job('j1', now + minutes(15)) }),
        json({ leaseExpiresAt: now + minutes(25) }),
        json({ leaseExpiresAt: now + minutes(35) }),
        json({ submissionId: 's1', status: 'pending' }, 202),
        new Response(null, { status: 204 }),
      );
      const generate = async () => {
        await vi.advanceTimersByTimeAsync(minutes(25)); // past the original 15-minute lease
        return { file: new Blob(['x']) };
      };
      // No onProgress: the count must not depend on it.
      expect(await client().contribute({ models, generate })).toEqual({
        submitted: 1,
        stopped: 'no-work',
      });
      expect(fetch.mock.calls.map(([url]) => url.slice(base.length))).toEqual([
        '/claim',
        '/jobs/j1/lease',
        '/jobs/j1/lease',
        '/jobs/j1/result',
        '/claim',
      ]);
    });

    it('abandons the job only once extending fails', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const now = Date.now();
      const fetch = mockFetch(
        json({ job: job('j1', now + minutes(15)) }),
        new Response('{"error":"cap"}', { status: 409 }),
      );
      const generate = async () => {
        await vi.advanceTimersByTimeAsync(minutes(20));
        return { file: new Blob(['x']) };
      };
      expect(await client().contribute({ models, generate })).toEqual({
        submitted: 0,
        stopped: 'lease-expired',
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('manifest is public and returns absolute URLs', async () => {
    const fetch = mockFetch(
      json({
        artifacts: [
          {
            key: 'a',
            jobId: 'j1',
            url: '/v1/apps/books/generation/artifacts/j1',
            metaUrl: '/v1/apps/books/generation/artifacts/j1/meta',
          },
          { key: 'b', jobId: 'j2', url: '/v1/apps/books/generation/artifacts/j2' },
        ],
      }),
    );
    const [a, b] = await client(null).manifest('s1');
    expect(fetch.mock.calls[0]![0]).toBe(`${base}/sets/s1/manifest`);
    expect(fetch.mock.calls[0]![1]).toBeUndefined();
    expect(a!.url).toBe(`${base}/artifacts/j1`);
    expect(a!.metaUrl).toBe(`${base}/artifacts/j1/meta`);
    expect(b!.metaUrl).toBeUndefined();
  });
});
