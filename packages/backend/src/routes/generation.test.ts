import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { M4A, OGG, SENTENCE, wav } from '../lib/generation-audio.testutil.js';
import { _resetJwksCache } from '../lib/github-oidc.js';
import { nativeHash } from '../lib/native-companion.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import { APP_ORG_ID, DEPLOY_AUDIENCE } from './deploy.js';
import {
  acceptSubmission,
  GENERATION_LIMITS,
  pruneGenerated,
  verifyPending,
} from './generation.js';

const KEY = 'a'.repeat(64);
const DEVICE = `ndev_${'b'.repeat(64)}`;
const AUDIO = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const MODEL = { model: 'kokoro', modelVersion: '1.0' };
const SET = { kind: 'tts', ...MODEL, params: { voice: 'af' }, formats: ['audio/wav'] };

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, body: Uint8Array | ArrayBuffer | string) {
      objects.set(
        key,
        typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body),
      );
    },
    async get(key: string) {
      const b = objects.get(key);
      return b
        ? {
            body: b,
            size: b.length,
            arrayBuffer: async () => b.slice().buffer,
            text: async () => new TextDecoder().decode(b),
          }
        : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  } as unknown as R2Bucket;
  return { objects, bucket };
}

/** `verify: false` keeps uploads pending: the verifier's read of each upload fails, so it retries later. */
async function setup({ verify = true } = {}) {
  const { db, d1 } = sqliteD1();
  db.exec(`INSERT INTO users (id, github_id, github_login, created_at) VALUES
      ('u1', 1, 'alice', 0), ('u2', 2, 'bob', 0), ('u3', 3, 'carol', 0), ('u4', 4, 'dave', 0);
    INSERT INTO apps (id, owner_login, created_at) VALUES ('books', 'alice', 0), ('other', 'alice', 0);`);
  db.prepare(
    "INSERT INTO native_devices (id, user_id, label, token_hash, created_at, expires_at) VALUES ('d1', 'u4', 'Pixel', ?, 0, ?)",
  ).run(await nativeHash(DEVICE), Date.now() + 86400000);
  const { objects, bucket } = memoryBucket();
  if (!verify) {
    const get = bucket.get.bind(bucket);
    const held = new Set<string>();
    bucket.get = (async (key: string) => {
      if (key.startsWith('q/') && !key.endsWith('.meta') && !held.has(key)) {
        held.add(key);
        throw new Error('verification held by the test');
      }
      return get(key);
    }) as R2Bucket['get'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }
  const env = { DB: d1, SESSION_SIGNING_KEY: KEY, GENERATED: bucket };
  const background: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => background.push(p),
    passThroughOnException() {},
    props: {},
  };
  const settled = () => Promise.all(background.splice(0));
  const request = async (
    path: string,
    o: {
      method?: string;
      user?: string | null;
      token?: string | undefined;
      json?: unknown;
      body?: BodyInit;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const { user = 'u1', method = 'GET' } = o;
    const token = o.token ?? (user ? await signSession(user, KEY, { aud: 'books' }) : null);
    return app.request(
      `/v1/apps/books/generation${path}`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(o.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...o.headers,
        },
        ...(o.json !== undefined
          ? { body: JSON.stringify(o.json) }
          : o.body
            ? { body: o.body }
            : {}),
      },
      env,
      ctx as unknown as ExecutionContext,
    );
  };
  const createSet = async (extra: Record<string, unknown> = {}) => {
    const r = await request('/sets', {
      method: 'POST',
      json: { ...SET, maxBytes: 1000, replicas: 1, ...extra },
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { set: { id: string } }).set.id;
  };
  const addJobs = (setId: string, jobs: unknown[]) =>
    request(`/sets/${setId}/jobs`, { method: 'POST', json: { jobs } });
  const claim = async (
    user: string | null,
    o: { token?: string; setId?: string; runner?: string } = {},
  ) => {
    const r = await request('/claim', {
      method: 'POST',
      user,
      token: o.token,
      json: { setId: o.setId, models: [MODEL] },
      ...(o.runner !== undefined && { headers: { 'X-Runner-Id': o.runner } }),
    });
    if (r.status === 204) return null;
    expect(r.status).toBe(200);
    return (
      (await r.json()) as { job: { id: string; key: string; leaseToken: string; setId: string } }
    ).job;
  };
  const submit = (
    user: string | null,
    jobId: string,
    lease: string,
    o: { token?: string; file?: Uint8Array; type?: string; meta?: string } = {},
  ) => {
    const form = new FormData();
    form.set('file', new Blob([o.file ?? AUDIO], { type: o.type ?? 'audio/wav' }), 'a.wav');
    if (o.meta !== undefined) form.set('meta', o.meta);
    return request(`/jobs/${jobId}/result`, {
      method: 'PUT',
      user,
      token: o.token,
      body: form,
      headers: { 'X-Lease-Token': lease },
    });
  };
  const submissionId = async (r: Response) => {
    expect(r.status).toBe(202);
    return (await r.json()) as { submissionId: string; status: string };
  };
  return {
    db,
    d1,
    env,
    objects,
    request,
    createSet,
    addJobs,
    claim,
    submit,
    submissionId,
    settled,
  };
}

describe.skipIf(!hasSqlite)('community generation jobs API', () => {
  it('only the owner creates sets and jobs; invalid sets are refused', async () => {
    const s = await setup();
    expect(
      (
        await s.request('/sets', {
          method: 'POST',
          user: 'u2',
          json: { ...SET, maxBytes: 10, replicas: 1 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await s.request('/sets', {
          method: 'POST',
          user: null,
          json: { ...SET, maxBytes: 10, replicas: 1 },
        })
      ).status,
    ).toBe(401);
    expect(
      (await s.request('/sets', { method: 'POST', json: { ...SET, maxBytes: 10, replicas: 4 } }))
        .status,
    ).toBe(400);
    expect(
      (
        await s.request('/sets', {
          method: 'POST',
          json: { ...SET, formats: ['text/html'], maxBytes: 10, replicas: 1 },
        })
      ).status,
    ).toBe(400);
    const setId = await s.createSet();
    expect(
      (
        await s.request(`/sets/${setId}/jobs`, {
          method: 'POST',
          user: 'u2',
          json: { jobs: [{ key: 'a', input: { text: 'x' } }] },
        })
      ).status,
    ).toBe(403);
    expect(s.db.prepare('SELECT action FROM generation_audit').all()).toEqual([
      { action: 'set.create' },
    ]);
  });

  it('job ids are content-derived; same key with a changed input is 409', async () => {
    const s = await setup();
    const setId = await s.createSet();
    const first = await s.addJobs(setId, [{ key: 'ch1/p1', input: { text: 'Hello there.' } }]);
    expect(first.status).toBe(200);
    const { jobs } = (await first.json()) as { jobs: { id: string; status: string }[] };
    expect(jobs[0]!.status).toBe('open');
    expect(jobs[0]!.id).toMatch(/^[a-f0-9]{64}$/);
    const again = (await (
      await s.addJobs(setId, [{ key: 'ch1/p1', input: { text: 'Hello there.' } }])
    ).json()) as { jobs: { id: string }[] };
    expect(again.jobs[0]!.id).toBe(jobs[0]!.id);
    const changed = await s.addJobs(setId, [
      { key: 'ch1/p2', input: { text: 'New.' } },
      { key: 'ch1/p1', input: { text: 'Changed.' } },
    ]);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual(expect.objectContaining({ keys: ['ch1/p1'] }));
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 1 });
    expect((await s.addJobs(setId, [])).status).toBe(400);
    expect(
      (
        await s.addJobs(setId, [
          { key: 'a', input: { text: 'x'.repeat(GENERATION_LIMITS.textChars + 1) } },
        ])
      ).status,
    ).toBe(400);
  });

  it('claims: one open lease per runner, never the same job twice, matching models only', async () => {
    const s = await setup();
    const setId = await s.createSet();
    await s.addJobs(setId, [
      { key: 'a', input: { text: 'A.' } },
      { key: 'b', input: { text: 'B.' } },
    ]);
    expect(
      (await s.request('/claim', { method: 'POST', user: null, json: { models: [MODEL] } })).status,
    ).toBe(401);
    expect(
      (
        await s.request('/claim', {
          method: 'POST',
          user: 'u2',
          json: { models: [{ model: 'kokoro', modelVersion: '2.0' }] },
        })
      ).status,
    ).toBe(204);
    const j1 = await s.claim('u2');
    expect(j1).toEqual(
      expect.objectContaining({
        key: 'a',
        setId,
        input: { text: 'A.' },
        formats: ['audio/wav'],
        maxBytes: 1000,
      }),
    );
    // A new claim releases the open lease; the released job never comes back to this user.
    const j2 = await s.claim('u2');
    expect(j2?.key).toBe('b');
    expect(await s.claim('u2')).toBeNull();
    expect((await s.submit('u2', j1!.id, j1!.leaseToken)).status).toBe(403);
    // The released job is free for another user.
    expect((await s.claim('u3'))?.key).toBe('a');
  });

  it('a lease that lapsed by interruption gives the job back; a skip or an upload keeps it given up (#841)', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet({ replicas: 2 });
    await s.addJobs(
      setId,
      ['a', 'b', 'c', 'd'].map((key) => ({ key, input: { text: `${key}.` } })),
    );
    const record = (user: string, jobId: string, reason: string) =>
      s.request('/events', {
        method: 'POST',
        user,
        json: { events: [{ jobId, runner: 'android', reason }] },
      });
    // Stopped mid-job (the run ended): the next claim releases it and takes the same job again.
    const a = (await s.claim('u2'))!;
    expect(a.key).toBe('a');
    await record('u2', a.id, 'background_expired');
    const a2 = (await s.claim('u2'))!;
    expect(a2.key).toBe('a');
    expect(a2.leaseToken).not.toBe(a.leaseToken);
    // The old token can neither extend nor upload; the new one does.
    const extend = (token: string) =>
      s.request(`/jobs/${a.id}/lease`, {
        method: 'POST',
        user: 'u2',
        headers: { 'X-Lease-Token': token },
      });
    expect((await extend(a.leaseToken)).status).toBe(403);
    expect((await extend(a2.leaseToken)).status).toBe(200);
    expect((await s.submit('u2', a.id, a.leaseToken)).status).toBe(403);
    await s.submissionId(await s.submit('u2', a2.id, a2.leaseToken));
    // Uploaded: never given to u2 again, so u2 provides one replica at most.
    const b = (await s.claim('u2'))!;
    expect(b.key).toBe('b');
    // Skipped (an unsupported voice), or released with no record: given up.
    await record('u2', b.id, 'unsupported');
    const c = (await s.claim('u2'))!;
    expect(c.key).toBe('c');
    const d = (await s.claim('u2'))!;
    expect(d.key).toBe('d');
    // Ran out unreleased with no record (the app was killed): given back once the lease is over,
    // before the skipped b and c.
    s.db.prepare('UPDATE generation_leases SET expires_at = 0 WHERE job_id = ?').run(d.id);
    expect((await s.claim('u2', { runner: 'tablet-01' }))?.key).toBe('d');
    // Its new attempt's record says it was too large: given up.
    s.db.prepare('UPDATE generation_leases SET expires_at = 0 WHERE job_id = ?').run(d.id);
    await record('u2', d.id, 'too_large');
    expect(await s.claim('u2', { runner: 'tablet-01' })).toBeNull();
    // The second replica still goes to another user.
    expect((await s.claim('u3', { setId }))?.key).toBe('a');
  });

  it("one open lease per runner: a user's devices keep theirs, up to 4 in all (#825)", async () => {
    const s = await setup();
    const setId = await s.createSet();
    await s.addJobs(
      setId,
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => ({ key, input: { text: `${key}.` } })),
    );
    // u4's phone (its ndev_ credential) and two browsers hold leases at once.
    const phone = (await s.claim(null, { token: DEVICE }))!;
    const laptop = (await s.claim('u4', { runner: 'laptop-01' }))!;
    const tablet = (await s.claim('u4', { runner: 'tablet-01' }))!;
    expect(new Set([phone.key, laptop.key, tablet.key]).size).toBe(3);
    // Re-claiming on one runner releases only that runner's lease.
    const laptop2 = (await s.claim('u4', { runner: 'laptop-01' }))!;
    expect((await s.submit('u4', laptop.id, laptop.leaseToken)).status).toBe(403);
    // A session without X-Runner-Id is one default runner, as before.
    expect(await s.claim('u4')).not.toBeNull();
    // A fifth runner is over the cap.
    const over = await s.request('/claim', {
      method: 'POST',
      user: 'u4',
      json: { models: [MODEL] },
      headers: { 'X-Runner-Id': 'desktop-01' },
    });
    expect(over.status).toBe(429);
    expect(await over.text()).toMatch(/at most 4 open leases/);
    // Every device still holding a lease submits it.
    await s.submissionId(await s.submit(null, phone.id, phone.leaseToken, { token: DEVICE }));
    await s.submissionId(await s.submit('u4', tablet.id, tablet.leaseToken));
    await s.submissionId(await s.submit('u4', laptop2.id, laptop2.leaseToken));
    // With leases freed, the new runner claims; no job is ever given to u4 twice.
    const desktop = (await s.claim('u4', { runner: 'desktop-01' }))!;
    expect([phone, laptop, tablet, laptop2].map((j) => j.key)).not.toContain(desktop.key);
    expect(
      (
        await s.request('/claim', {
          method: 'POST',
          user: 'u4',
          json: { models: [MODEL] },
          headers: { 'X-Runner-Id': 'short' },
        })
      ).status,
    ).toBe(400);
  });

  it('replicas go to distinct users and cap concurrent leases', async () => {
    const s = await setup();
    const one = await s.createSet();
    await s.addJobs(one, [{ key: 'a', input: { text: 'A.' } }]);
    expect(await s.claim('u2')).not.toBeNull();
    expect(await s.claim('u3')).toBeNull();
    const two = await s.createSet({ replicas: 2 });
    await s.addJobs(two, [{ key: 'a', input: { text: 'A.' } }]);
    const a = await s.claim('u2', { setId: two });
    const b = await s.claim('u3', { setId: two });
    expect(a?.id).toBe(b?.id);
    expect(await s.claim('u4', { setId: two })).toBeNull();
  });

  it('submits need a valid lease, an allowed format and size; a lease uploads once', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet();
    await s.addJobs(setId, [{ key: 'a', input: { text: 'A.' } }]);
    const job = (await s.claim('u2'))!;
    expect((await s.submit('u2', job.id, `glt_${'0'.repeat(64)}`)).status).toBe(403);
    expect((await s.submit('u3', job.id, job.leaseToken)).status).toBe(403);
    expect((await s.submit('u2', job.id, job.leaseToken, { type: 'audio/ogg' })).status).toBe(415);
    expect(
      (await s.submit('u2', job.id, job.leaseToken, { file: new Uint8Array(1001) })).status,
    ).toBe(413);
    expect((await s.submit('u2', job.id, job.leaseToken, { meta: '[1]' })).status).toBe(400);
    expect(s.objects.size).toBe(0);
    const ok = await s.submissionId(
      await s.submit('u2', job.id, job.leaseToken, { meta: '{"segments":[]}' }),
    );
    expect(ok.status).toBe('pending');
    expect([...s.objects.keys()].every((k) => k.startsWith(`q/books/${job.id}/`))).toBe(true);
    expect((await s.submit('u2', job.id, job.leaseToken)).status).toBe(403);
    const list = (await (await s.request('/submissions', { user: 'u2' })).json()) as {
      submissions: unknown[];
    };
    expect(list.submissions).toEqual([
      expect.objectContaining({
        submissionId: ok.submissionId,
        jobId: job.id,
        key: 'a',
        status: 'pending',
        durationMs: null,
        report: null,
        input: { text: 'A.' },
        artifact: null,
      }),
    ]);
    expect(
      (
        (await (await s.request('/submissions', { user: 'u3' })).json()) as {
          submissions: unknown[];
        }
      ).submissions,
    ).toEqual([]);
  });

  it('extends an open lease to 15 minutes from now, capped at 2 hours after the claim', async () => {
    const s = await setup();
    const setId = await s.createSet();
    await s.addJobs(setId, [
      { key: 'a', input: { text: 'A.' } },
      { key: 'b', input: { text: 'B.' } },
    ]);
    const job = (await s.claim('u2'))!;
    const extend = (user: string | null, lease: string, jobId = job.id, token?: string) =>
      s.request(`/jobs/${jobId}/lease`, {
        method: 'POST',
        user,
        token,
        headers: { 'X-Lease-Token': lease },
      });
    const lease = (expiresAt: number, createdAt: number) =>
      s.db
        .prepare('UPDATE generation_leases SET expires_at = ?, created_at = ? WHERE job_id = ?')
        .run(expiresAt, createdAt, job.id);
    expect((await extend(null, job.leaseToken)).status).toBe(401);
    expect((await extend('u2', `glt_${'0'.repeat(64)}`)).status).toBe(403);
    expect((await extend('u2', 'nope')).status).toBe(403);
    expect((await extend('u3', job.leaseToken)).status).toBe(403);
    const before = Date.now();
    const r = await extend('u2', job.leaseToken);
    expect(r.status).toBe(200);
    const { leaseExpiresAt } = (await r.json()) as { leaseExpiresAt: number };
    expect(leaseExpiresAt).toBeGreaterThanOrEqual(before + GENERATION_LIMITS.leaseMs);
    // Near the cap, the extension stops at claim + 2 h; then it is 409.
    const claimedAt = Date.now() - GENERATION_LIMITS.leaseMaxMs + 5 * 60_000;
    lease(Date.now() + 60_000, claimedAt);
    const capped = (await (await extend('u2', job.leaseToken)).json()) as {
      leaseExpiresAt: number;
    };
    expect(capped.leaseExpiresAt).toBe(claimedAt + GENERATION_LIMITS.leaseMaxMs);
    const refused = await extend('u2', job.leaseToken);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual(
      expect.objectContaining({ leaseExpiresAt: claimedAt + GENERATION_LIMITS.leaseMaxMs }),
    );
    // An extended lease still holds the job past the first 15 minutes: no one
    // else claims it, and the upload is accepted.
    lease(Date.now() + 10 * 60_000, Date.now() - 60 * 60_000);
    const b = (await s.claim('u3'))!;
    expect(b.key).toBe('b');
    await s.submissionId(await s.submit('u2', job.id, job.leaseToken));
    // A used lease cannot be extended, nor an expired one.
    expect((await extend('u2', job.leaseToken)).status).toBe(403);
    s.db
      .prepare('UPDATE generation_leases SET expires_at = ? WHERE job_id = ?')
      .run(Date.now() - 1, b.id);
    expect((await extend('u3', b.leaseToken, b.id)).status).toBe(403);
  });

  it('accepted artifacts are write-once and public; later submissions are superseded', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet({ replicas: 2 });
    await s.addJobs(setId, [{ key: 'a', input: { text: 'A.' } }]);
    const a = (await s.claim('u2'))!;
    const b = (await s.claim('u3'))!;
    const first = await s.submissionId(
      await s.submit('u2', a.id, a.leaseToken, { meta: '{"x":1}' }),
    );
    const second = await s.submissionId(
      await s.submit('u3', b.id, b.leaseToken, { file: new Uint8Array([9, 9]) }),
    );
    expect(await acceptSubmission(s.env as never, first.submissionId, 1234)).toBe('accepted');
    // The other pending submission was superseded with the accept; a forced second accept cannot overwrite.
    expect(
      s.db
        .prepare('SELECT status FROM generation_submissions WHERE id = ?')
        .get(second.submissionId),
    ).toEqual({ status: 'superseded' });
    s.db
      .prepare("UPDATE generation_submissions SET status = 'pending' WHERE id = ?")
      .run(second.submissionId);
    expect(await acceptSubmission(s.env as never, second.submissionId, 1)).toBe('superseded');
    const manifest = await s.request(`/sets/${setId}/manifest`, { user: null });
    expect(manifest.headers.get('cache-control')).toBe('public, max-age=60');
    const { artifacts } = (await manifest.json()) as {
      artifacts: {
        url: string;
        metaUrl: string;
        durationMs: number;
        bytes: number;
        sha256: string;
      }[];
    };
    expect(artifacts).toHaveLength(1);
    // The contributor's own listing links the same artifact and meta (#824).
    const mine = (await (await s.request('/submissions', { user: 'u2' })).json()) as {
      submissions: { artifact: unknown }[];
    };
    expect(mine.submissions[0]!.artifact).toEqual({
      url: artifacts[0]!.url,
      metaUrl: artifacts[0]!.metaUrl,
    });
    expect(artifacts[0]).toEqual(
      expect.objectContaining({
        key: 'a',
        jobId: a.id,
        bytes: AUDIO.length,
        durationMs: 1234,
        contentType: 'audio/wav',
        model: 'kokoro',
        modelVersion: '1.0',
      }),
    );
    const read = await app.request(artifacts[0]!.url, {}, s.env);
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(AUDIO);
    expect(await (await app.request(artifacts[0]!.metaUrl, {}, s.env)).json()).toEqual({ x: 1 });
    expect(
      (await app.request(`/v1/apps/books/generation/artifacts/${a.id}?v=0000`, {}, s.env)).status,
    ).toBe(404);
    // Quarantine was emptied of the accepted bytes; artifacts live under a/.
    expect(
      [...s.objects.keys()]
        .filter((k) => k.startsWith('q/'))
        .some((k) => k.includes(first.submissionId)),
    ).toBe(false);
    expect(s.db.prepare('SELECT status FROM generation_jobs').all()).toEqual([
      { status: 'accepted' },
    ]);
    // An accepted job is no longer claimable.
    expect(await s.claim('u4')).toBeNull();
  });

  it('owner withdraw reopens the job (audited); block refuses and withdraws a contributor', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet();
    await s.addJobs(setId, [
      { key: 'a', input: { text: 'A.' } },
      { key: 'b', input: { text: 'B.' } },
    ]);
    const accept = async (user: string) => {
      const job = (await s.claim(user))!;
      const { submissionId } = await s.submissionId(await s.submit(user, job.id, job.leaseToken));
      await acceptSubmission(s.env as never, submissionId, null);
      return job;
    };
    const ja = await accept('u2');
    expect((await s.request(`/artifacts/${ja.id}`, { method: 'DELETE', user: 'u2' })).status).toBe(
      403,
    );
    expect((await s.request(`/artifacts/${ja.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await s.request(`/artifacts/${ja.id}`, { user: null })).status).toBe(404);
    expect(s.db.prepare('SELECT status FROM generation_jobs WHERE key = ?').get('a')).toEqual({
      status: 'open',
    });
    expect((await s.claim('u3'))?.key).toBe('a');
    const jb = await accept('u2');
    expect(jb.key).toBe('b');
    const blocked = await s.request('/contributors/u2/block', { method: 'POST' });
    expect(await blocked.json()).toEqual({ blocked: true, withdrawn: 1 });
    expect(
      (await s.request('/claim', { method: 'POST', user: 'u2', json: { models: [MODEL] } })).status,
    ).toBe(403);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM generation_artifacts').get()).toEqual({ n: 0 });
    expect([...s.objects.keys()].filter((k) => k.startsWith('a/'))).toEqual([]);
    expect(s.db.prepare('SELECT action FROM generation_audit ORDER BY id').all()).toEqual([
      { action: 'set.create' },
      { action: 'artifact.withdraw' },
      { action: 'contributor.block' },
    ]);
  });

  it('native devices contribute with their ndev_ credential', async () => {
    const s = await setup();
    const setId = await s.createSet();
    await s.addJobs(setId, [{ key: 'a', input: { text: 'A.' } }]);
    const job = (await s.claim(null, { token: DEVICE }))!;
    const r = await s.submissionId(await s.submit(null, job.id, job.leaseToken, { token: DEVICE }));
    expect(
      s.db
        .prepare('SELECT user_id, device_kind FROM generation_submissions WHERE id = ?')
        .get(r.submissionId),
    ).toEqual({ user_id: 'u4', device_kind: 'native' });
    expect(await s.claim(null, { token: `ndev_${'c'.repeat(64)}` }).catch(() => 'refused')).toBe(
      'refused',
    );
  });

  it('people judge quality: device reports and owner reviews of exact versions (#831, #787)', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet();
    await s.addJobs(setId, [{ key: 'a', input: { text: 'A.' } }]);
    const job = (await s.claim(null, { token: DEVICE }))!;
    const { submissionId } = await s.submissionId(
      await s.submit(null, job.id, job.leaseToken, { token: DEVICE }),
    );
    type Judged = {
      jobs: { artifact: Record<string, unknown> | null; submissions: Record<string, unknown>[] }[];
    };
    const device = { user: null, token: DEVICE };
    const report = (json: unknown, o: { user?: string | null; token?: string } = device) =>
      s.request(`/submissions/${submissionId}/report`, { method: 'PUT', json, ...o });
    // Only the contributor, about their own upload; the device credential works.
    expect((await report({ good: false }, { user: 'u2' })).status).toBe(404);
    expect((await report({ good: false }, { user: null })).status).toBe(401);
    expect((await report({ good: 'yes' })).status).toBe(400);
    expect((await report({ good: false, note: 'x'.repeat(501) })).status).toBe(400);
    expect((await report({ good: false, note: 'skips a line' })).status).toBe(200);
    const good = { good: true, note: null, at: expect.any(Number) };
    expect(await (await report({ good: true })).json()).toEqual({ report: good });
    const mine = (await (await s.request('/submissions', device)).json()) as {
      submissions: { report: unknown }[];
    };
    expect(mine.submissions[0]!.report).toEqual(good);

    // The owner reviews the accepted version on a console session, never an app session.
    await acceptSubmission(s.env as never, submissionId, 1000);
    const consoleSession = await signSession('u1', KEY, { aud: 'console' });
    const review = async (json: unknown, token = consoleSession) =>
      await s.request(`/artifacts/${job.id}/review`, { method: 'PUT', json, token });
    const reviewed = { submissionId, status: 'reviewed' };
    expect((await review(reviewed, await signSession('u1', KEY, { aud: 'books' }))).status).toBe(
      403,
    );
    expect((await review(reviewed, await signSession('u2', KEY, { aud: 'console' }))).status).toBe(
      403,
    );
    expect((await review({ submissionId, status: 'great' })).status).toBe(400);
    expect((await review({ submissionId: 'other', status: 'reviewed' })).status).toBe(409);
    const note = 'wrong stress on "record"';
    const ok = await review({ submissionId, status: 'needs_changes', note });
    expect(await ok.json()).toEqual({
      review: { status: 'needs_changes', note, by: 'alice', at: expect.any(Number) },
    });
    const listed = (await (await s.request(`/sets/${setId}/jobs`)).json()) as Judged;
    expect(listed.jobs[0]!.artifact!.review).toEqual(
      expect.objectContaining({ status: 'needs_changes', by: 'alice' }),
    );
    expect(listed.jobs[0]!.submissions[0]!.report).toEqual(good);
    expect(
      s.db
        .prepare(
          "SELECT actor, target, detail FROM generation_audit WHERE action = 'artifact.review'",
        )
        .all(),
    ).toEqual([
      {
        actor: 'u1',
        target: submissionId,
        detail: JSON.stringify({ status: 'needs_changes', note }),
      },
    ]);
    // Filter by review (#787); the history (#791) keeps every review of every version, newest first.
    const byReview = async (r: string) =>
      ((await (await s.request(`/sets/${setId}/jobs?review=${r}`)).json()) as Judged).jobs.length;
    expect([
      await byReview('needs_changes'),
      await byReview('reviewed'),
      await byReview('unreviewed'),
    ]).toEqual([1, 0, 0]);
    expect((await s.request(`/sets/${setId}/jobs?review=great`)).status).toBe(400);
    await review({ submissionId, status: 'reviewed' });
    const history = async () =>
      (
        (await (await s.request(`/sets/${setId}/jobs/${job.id}`)).json()) as {
          job: { reviews: unknown[] };
        }
      ).job.reviews;
    expect(await history()).toEqual([
      { submissionId, status: 'reviewed', note: null, by: 'alice', at: expect.any(Number) },
      { submissionId, status: 'needs_changes', note, by: 'alice', at: expect.any(Number) },
    ]);
    expect((await s.request(`/sets/${setId}/jobs/${job.id}`, { user: 'u2' })).status).toBe(403);
    await review({ submissionId, status: 'needs_changes', note });
    // A review changes nothing public.
    const manifest = await (await s.request(`/sets/${setId}/manifest`, { user: null })).json();
    expect((manifest as { artifacts: unknown[] }).artifacts).toHaveLength(1);

    // Withdrawn and generated again: the new version is unreviewed; the old review never carries over.
    expect((await s.request(`/artifacts/${job.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await review(reviewed)).status).toBe(404);
    const again = (await s.claim('u3'))!;
    const next = await s.submissionId(await s.submit('u3', again.id, again.leaseToken));
    await acceptSubmission(s.env as never, next.submissionId, 1000);
    const relisted = (await (await s.request(`/sets/${setId}/jobs`)).json()) as Judged;
    expect(relisted.jobs[0]!.artifact).toEqual(
      expect.objectContaining({ submissionId: next.submissionId, review: null }),
    );
    expect((await review(reviewed)).status).toBe(409);
    expect(await byReview('unreviewed')).toBe(1);
    expect((await history()).map((r) => (r as { submissionId: string }).submissionId)).toEqual([
      submissionId,
      submissionId,
      submissionId,
    ]);
  });

  it('review queue, contributor good rates and the owner-set auto-block (#842)', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet();
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    await s.addJobs(
      setId,
      keys.map((key) => ({ key, input: { text: `${key}.` } })),
    );
    // u2 makes five accepted artifacts, u3 two.
    const made: { jobId: string; submissionId: string; user: string }[] = [];
    for (const user of ['u2', 'u2', 'u2', 'u2', 'u2', 'u3', 'u3']) {
      const job = (await s.claim(user))!;
      const { submissionId } = await s.submissionId(await s.submit(user, job.id, job.leaseToken));
      await acceptSubmission(s.env as never, submissionId, 1000);
      made.push({ jobId: job.id, submissionId, user });
    }
    const report = (i: number, good: boolean) =>
      s.request(`/submissions/${made[i]!.submissionId}/report`, {
        method: 'PUT',
        user: made[i]!.user,
        json: { good },
      });
    await report(1, true);
    await report(2, false);
    type Queue = { items: { key: string; submissionId: string; report: unknown; url: string }[] };
    const queue = async () =>
      ((await (await s.request(`/review?setId=${setId}`)).json()) as Queue).items;
    // Reported not good first, then unreported, then reported good; oldest first within each.
    expect((await queue()).map((i) => i.key)).toEqual(['c', 'a', 'd', 'e', 'f', 'g', 'b']);
    expect((await s.request('/review', { user: 'u2' })).status).toBe(403);
    const consoleSession = await signSession('u1', KEY, { aud: 'console' });
    const review = (i: number, status: string) =>
      s.request(`/artifacts/${made[i]!.jobId}/review`, {
        method: 'PUT',
        token: consoleSession,
        json: { submissionId: made[i]!.submissionId, status },
      });
    expect((await review(2, 'reviewed')).status).toBe(200);
    expect((await queue()).map((i) => i.key)).not.toContain('c');

    // The owner's review outweighs the device's report: c is good.
    type Listed = {
      autoBlockBelow: number | null;
      contributors: {
        contributor: { id: string };
        judged: number;
        good: number;
        goodRate: number | null;
        blocked: boolean;
      }[];
    };
    const contributors = async () => (await (await s.request('/contributors')).json()) as Listed;
    const u2 = async () =>
      (await contributors()).contributors.find((r) => r.contributor.id === 'u2')!;
    expect(await u2()).toEqual(
      expect.objectContaining({ judged: 2, good: 2, goodRate: 1, blocked: false }),
    );
    expect(
      (await contributors()).contributors.find((r) => r.contributor.id === 'u3')!.goodRate,
    ).toBeNull();

    // Auto-block: console session of the owner only, a rate from 0 to 1 or null.
    const settings = (json: unknown, token = consoleSession) =>
      s.request('/settings', { method: 'PUT', token, json });
    expect(
      (await settings({ autoBlockBelow: 0.5 }, await signSession('u1', KEY, { aud: 'books' })))
        .status,
    ).toBe(403);
    expect((await settings({ autoBlockBelow: 2 })).status).toBe(400);
    expect((await settings({ autoBlockBelow: 0.5 })).status).toBe(200);
    expect((await contributors()).autoBlockBelow).toBe(0.5);
    // Fewer than 5 judged: not blocked yet, however bad.
    await review(0, 'needs_changes');
    await review(1, 'needs_changes');
    await review(3, 'needs_changes');
    expect((await u2()).blocked).toBe(false);
    // The fifth judgement brings u2 to 1 good of 5: blocked, everything withdrawn, audited.
    await review(4, 'needs_changes');
    expect(await u2()).toEqual(expect.objectContaining({ judged: 5, good: 1, blocked: true }));
    expect(
      s.db.prepare("SELECT COUNT(*) AS n FROM generation_artifacts WHERE user_id = 'u2'").get(),
    ).toEqual({ n: 0 });
    expect(
      s.db
        .prepare(
          "SELECT actor, target FROM generation_audit WHERE action = 'contributor.autoblock'",
        )
        .all(),
    ).toEqual([{ actor: 'auto-block', target: 'u2' }]);
    expect(
      (await s.request('/claim', { method: 'POST', user: 'u2', json: { models: [MODEL] } })).status,
    ).toBe(403);
    expect((await settings({ autoBlockBelow: null })).status).toBe(200);
  });

  it('the app daily limit is enforced; there is no per-user limit (#830)', async () => {
    const s = await setup();
    const setId = await s.createSet();
    await s.addJobs(setId, [{ key: 'a', input: { text: 'A.' } }]);
    const job = (await s.claim('u2'))!;
    s.db
      .prepare('INSERT INTO app_proxy_usage (app_id, day, count) VALUES (?, ?, ?)')
      .run('genapp:books', new Date().toISOString().slice(0, 10), GENERATION_LIMITS.appDaily);
    expect((await s.submit('u2', job.id, job.leaseToken)).status).toBe(429);
    // Once at the cap, a claim leases nothing (#828): the upload would be refused.
    await s.addJobs(setId, [{ key: 'b', input: { text: 'B.' } }]);
    const leases = () =>
      (
        s.db.prepare("SELECT COUNT(*) AS n FROM generation_leases WHERE user_id = 'u2'").get() as {
          n: number;
        }
      ).n;
    const before = leases();
    const refused = await s.request('/claim', {
      method: 'POST',
      user: 'u2',
      json: { models: [MODEL] },
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBeNull();
    expect(leases()).toBe(before);
  });

  it('unknown or non-FAS apps are 404; the manifest of an unknown set is 404', async () => {
    const s = await setup();
    expect((await s.request('/sets/nope/manifest', { user: null })).status).toBe(404);
    s.db.exec("UPDATE apps SET store = 'apps_pro' WHERE id = 'books'");
    expect((await s.request('/claim', { method: 'POST', json: { models: [MODEL] } })).status).toBe(
      404,
    );
  });

  it('the reaper removes artifacts and rows of deleted apps and expires stale pending submissions', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet();
    await s.addJobs(setId, [
      { key: 'a', input: { text: 'A.' } },
      { key: 'b', input: { text: 'B.' } },
    ]);
    const ja = (await s.claim('u2'))!;
    const sub = await s.submissionId(await s.submit('u2', ja.id, ja.leaseToken));
    await acceptSubmission(s.env as never, sub.submissionId, null);
    const jb = (await s.claim('u3'))!;
    const stale = await s.submissionId(await s.submit('u3', jb.id, jb.leaseToken));
    await pruneGenerated(s.env as never, Date.now() + GENERATION_LIMITS.pendingMs + 1);
    expect(
      s.db
        .prepare('SELECT status, reason FROM generation_submissions WHERE id = ?')
        .get(stale.submissionId),
    ).toEqual({ status: 'rejected', reason: 'expired before verification' });
    s.db.exec("DELETE FROM apps WHERE id = 'books'");
    await pruneGenerated(s.env as never);
    expect([...s.objects.keys()].filter((k) => k.startsWith('a/'))).toEqual([]);
    for (const t of [
      'generation_sets',
      'generation_jobs',
      'generation_artifacts',
      'generation_submissions',
      'generation_leases',
      'generation_audit',
    ])
      expect(s.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
  });
});

describe.skipIf(!hasSqlite)('community generation listing and discovery (#794)', () => {
  type Listed = {
    jobs: {
      key: string;
      status: string;
      inputPreview: string;
      inputChars: number;
      artifact: Record<string, unknown> | null;
      submissions: Record<string, unknown>[];
      attempts: Record<string, unknown>[];
    }[];
    nextCursor: string | null;
  };
  const open = async (
    s: Awaited<ReturnType<typeof setup>>,
    o: { user?: string; aud?: string; token?: string; appId?: string } = {},
  ) => {
    const token = o.token ?? (await signSession(o.user ?? 'u2', KEY, { aud: o.aud ?? 'console' }));
    return app.request(
      `/v1/generation/open${o.appId ? `?appId=${o.appId}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } },
      s.env,
    );
  };

  it('owner lists sets with progress counts', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet({ replicas: 2 });
    await s.addJobs(setId, [
      { key: 'a', input: { text: 'A.' } },
      { key: 'b', input: { text: 'B.' } },
      { key: 'c', input: { text: 'C.' } },
    ]);
    const accept = async (user: string) => {
      const job = (await s.claim(user, { setId }))!;
      const { submissionId } = await s.submissionId(await s.submit(user, job.id, job.leaseToken));
      return { job, submissionId };
    };
    const a = await accept('u2'); // a: pending
    await accept('u3'); // a: second replica, pending
    await acceptSubmission(s.env as never, a.submissionId, 1000); // a accepted, u3's superseded
    const b = await accept('u4'); // b: pending
    s.db
      .prepare("UPDATE generation_submissions SET status = 'rejected', reason = 'x' WHERE id = ?")
      .run(b.submissionId);
    await s.claim('u2', { setId }); // b: leased by u2
    expect((await s.request(`/artifacts/${a.job.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await s.request('/sets', { user: 'u2' })).status).toBe(403);
    const r = await s.request('/sets');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const { sets } = (await r.json()) as { sets: Record<string, unknown>[] };
    expect(sets).toEqual([
      expect.objectContaining({
        id: setId,
        appId: 'books',
        model: 'kokoro',
        replicas: 2,
        counts: {
          jobs: 3,
          open: 3,
          leased: 1,
          pending: 0,
          accepted: 0,
          rejected: 1,
          withdrawn: 1,
        },
      }),
    ]);
  });

  it('owner pages jobs with artifacts and latest submissions, filtered by status', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet();
    await s.addJobs(setId, [
      { key: 'a', input: { text: 'x'.repeat(300) } },
      { key: 'b', input: { text: 'B.' } },
      { key: 'c', input: { text: 'C.' } },
    ]);
    const job = (await s.claim('u2', { setId }))!;
    const sub = await s.submissionId(await s.submit('u2', job.id, job.leaseToken));
    await acceptSubmission(s.env as never, sub.submissionId, 1500);
    expect((await s.request(`/sets/${setId}/jobs`, { user: 'u2' })).status).toBe(403);
    expect((await s.request(`/sets/nope/jobs`)).status).toBe(404);
    expect((await s.request(`/sets/${setId}/jobs?status=leased`)).status).toBe(400);
    const first = (await (await s.request(`/sets/${setId}/jobs?limit=2`)).json()) as Listed;
    expect(first.jobs.map((j) => j.key)).toEqual(['a', 'b']);
    expect(first.nextCursor).toBe('b');
    const [a] = first.jobs;
    expect(a).toEqual(
      expect.objectContaining({
        status: 'accepted',
        inputChars: 300,
        createdAt: expect.any(Number),
      }),
    );
    expect(a!.inputPreview).toHaveLength(200);
    expect(a!.artifact).toEqual({
      url: expect.stringMatching(new RegExp(`/v1/apps/books/generation/artifacts/${job.id}\\?v=`)),
      durationMs: 1500,
      bytes: AUDIO.length,
      submissionId: sub.submissionId,
      contributor: { id: 'u2', login: 'bob' },
      acceptedAt: expect.any(Number),
      review: null,
    });
    expect(a!.submissions).toEqual([
      {
        id: sub.submissionId,
        contributor: { id: 'u2', login: 'bob' },
        deviceKind: 'web',
        attestation: 'none',
        status: 'accepted',
        reason: null,
        durationMs: null,
        createdAt: expect.any(Number),
        decidedAt: expect.any(Number),
        report: null,
        record: null,
      },
    ]);
    expect(a!.attempts).toEqual([]);
    expect(first.jobs[1]).toEqual(expect.objectContaining({ artifact: null, submissions: [] }));
    const rest = (await (await s.request(`/sets/${setId}/jobs?limit=2&cursor=b`)).json()) as Listed;
    expect(rest.jobs.map((j) => j.key)).toEqual(['c']);
    expect(rest.nextCursor).toBeNull();
    const accepted = (await (
      await s.request(`/sets/${setId}/jobs?status=accepted`)
    ).json()) as Listed;
    expect(accepted.jobs.map((j) => j.key)).toEqual(['a']);
  });

  it('attempt records: one per lease, numbers only, shown to the owner by submission or as an attempt (#827)', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet();
    await s.addJobs(setId, [
      { key: 'a', input: { text: 'A.' } },
      { key: 'b', input: { text: 'B.' } },
    ]);
    const send = (user: string, events: unknown) =>
      s.request('/events', { method: 'POST', user, json: { events } });
    const a = (await s.claim('u2', { setId }))!;
    const sub = await s.submissionId(await s.submit('u2', a.id, a.leaseToken));
    const b = (await s.claim('u3', { setId }))!;
    const numbers = {
      wallMs: 5200,
      loadMs: 900,
      synthMs: 3800,
      cpuMs: 7100,
      rtf: 0.4,
      batteryStart: 80,
      chargingStart: true,
    };
    const sent = await send('u2', [
      { jobId: a.id, runner: 'browser', reason: 'other', ...numbers },
      // Never leased by u2: ignored.
      { jobId: b.id, runner: 'browser', reason: 'submitted' },
    ]);
    expect(await sent.json()).toEqual({ recorded: 1 });
    // A resend replaces the lease's record.
    expect(
      await (
        await send('u2', [
          { jobId: a.id, runner: 'browser', reason: 'submitted', ...numbers, appVersion: '1.2' },
        ])
      ).json(),
    ).toEqual({ recorded: 1 });
    await send('u3', [
      { jobId: b.id, runner: 'android', reason: 'thermal', thermalEnd: 'severe', background: true },
    ]);
    for (const bad of [
      [],
      [{ jobId: a.id, runner: 'toaster', reason: 'submitted' }],
      [{ jobId: a.id, runner: 'ios', reason: 'bored' }],
      [{ jobId: a.id, runner: 'ios', reason: 'submitted', text: 'no text' }],
      [{ jobId: a.id, runner: 'ios', reason: 'submitted', cpuMs: -1 }],
      [{ jobId: a.id, runner: 'ios', reason: 'submitted', device: 'x'.repeat(301) }],
    ])
      expect((await send('u2', bad)).status).toBe(400);
    const { jobs } = (await (await s.request(`/sets/${setId}/jobs`)).json()) as Listed;
    const [ja, jb] = jobs;
    expect(ja!.submissions[0]!.id).toBe(sub.submissionId);
    expect(ja!.submissions[0]!.record).toEqual({
      runner: 'browser',
      reason: 'submitted',
      createdAt: expect.any(Number),
      ...numbers,
      appVersion: '1.2',
    });
    expect(ja!.attempts).toEqual([]);
    expect(jb!.attempts).toEqual([
      {
        contributor: { id: 'u3', login: 'carol' },
        runner: 'android',
        reason: 'thermal',
        createdAt: expect.any(Number),
        thermalEnd: 'severe',
        background: true,
      },
    ]);
    // Kept 14 days.
    await pruneGenerated(s.env as never, Date.now() + GENERATION_LIMITS.eventsKeepMs + 1);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM generation_events').get()).toEqual({ n: 0 });
  });

  it('owner reads one job with its whole input', async () => {
    const s = await setup({ verify: false });
    const setId = await s.createSet();
    const text = 'A sentence. '.repeat(30);
    await s.addJobs(setId, [{ key: 'a', input: { text } }]);
    const job = (await s.claim('u2', { setId }))!;
    const sub = await s.submissionId(await s.submit('u2', job.id, job.leaseToken));
    await acceptSubmission(s.env as never, sub.submissionId, 1500);
    expect((await s.request(`/sets/${setId}/jobs/${job.id}`, { user: 'u2' })).status).toBe(403);
    expect((await s.request(`/sets/nope/jobs/${job.id}`)).status).toBe(404);
    expect((await s.request(`/sets/${setId}/jobs/nope`)).status).toBe(404);
    const r = await s.request(`/sets/${setId}/jobs/${job.id}`);
    expect(r.status).toBe(200);
    const { job: one } = (await r.json()) as { job: Listed['jobs'][number] & { input: unknown } };
    const [listed] = ((await (await s.request(`/sets/${setId}/jobs`)).json()) as Listed).jobs;
    expect(one).toEqual({ ...listed, input: { text }, reviews: [] });
  });

  it('discovery shows what the caller could claim, under the claim rules', async () => {
    const s = await setup();
    const setId = await s.createSet({ replicas: 2 });
    await s.addJobs(setId, [
      { key: 'a', input: { text: 'A.' } },
      { key: 'b', input: { text: 'B.' } },
    ]);
    const attested = await s.createSet({ requireAttestation: true });
    await s.addJobs(attested, [{ key: 'a', input: { text: 'A.' } }]);
    s.db.exec(`INSERT INTO generation_sets (id, app_id, kind, model, model_version, params, formats, max_bytes, replicas, created_by, created_at)
      VALUES ('s-other', 'other', 'tts', 'm', 'v', '{}', '["audio/ogg"]', 10, 1, 'u1', 0);
      INSERT INTO generation_jobs (id, set_id, app_id, key, input, status, created_at)
      VALUES ('j-other', 's-other', 'other', 'k', '{"text":"K."}', 'open', 0);`);
    const sets = async (o: Parameters<typeof open>[1] = {}) => {
      const r = await open(s, o);
      expect(r.status).toBe(200);
      return (
        (await r.json()) as { apps: { appId: string; sets: { setId: string; open: number }[] }[] }
      ).apps;
    };
    const all = await sets();
    expect(all).toEqual([
      {
        appId: 'books',
        oneliner: null,
        sets: [
          {
            setId,
            kind: 'tts',
            model: 'kokoro',
            modelVersion: '1.0',
            params: { voice: 'af' },
            formats: ['audio/wav'],
            maxBytes: 1000,
            language: null,
            open: 2,
          },
        ],
      },
      expect.objectContaining({ appId: 'other', sets: [expect.objectContaining({ open: 1 })] }),
    ]);
    // A job the caller held once is never offered again; replica slots are shared.
    await s.claim('u2', { setId }); // u2 leases a
    await s.claim('u3', { setId }); // u3 leases a (second replica)
    expect((await sets())[0]!.sets[0]!.open).toBe(1); // u2: only b
    expect((await sets({ user: 'u4' }))[0]!.sets[0]!.open).toBe(1); // u4: a is full
    // One app only, with that app's session; an app session cannot see across apps.
    expect((await sets({ aud: 'books', appId: 'books' })).map((a) => a.appId)).toEqual(['books']);
    expect((await open(s, { aud: 'books' })).status).toBe(403);
    expect((await open(s, { aud: 'books', appId: 'other' })).status).toBe(403);
    expect((await open(s, { appId: 'Bad App' })).status).toBe(400);
    // Native devices discover with their ndev_ credential.
    expect((await sets({ token: DEVICE })).map((a) => a.appId)).toEqual(['books', 'other']);
    // Blocked: that app disappears; asking for it is the claim's 403.
    await s.request('/contributors/u2/block', { method: 'POST' });
    expect((await sets()).map((a) => a.appId)).toEqual(['other']);
    expect((await open(s, { appId: 'books' })).status).toBe(403);
    // Unpublished apps are not offered.
    s.db.exec("UPDATE apps SET store = 'apps_pro' WHERE id = 'other'");
    expect(await sets()).toEqual([]);
  });
});

describe.skipIf(!hasSqlite)('community generation owner calls from GitHub Actions OIDC', () => {
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const b64json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  let priv: CryptoKey;
  let jwk: JsonWebKey;
  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    priv = pair.privateKey;
    jwk = {
      ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey),
      kid: 'gen',
    } as JsonWebKey;
  });
  afterEach(() => vi.unstubAllGlobals());
  const oidc = async (repositoryId: string, ref = 'refs/heads/main') => {
    const now = Math.floor(Date.now() / 1000);
    const h = b64json({ alg: 'RS256', kid: 'gen' });
    const p = b64json({
      iss: 'https://token.actions.githubusercontent.com',
      aud: DEPLOY_AUDIENCE,
      sub: 'repo:freeappstore-online/books',
      repository: 'freeappstore-online/books',
      repository_owner: 'freeappstore-online',
      repository_owner_id: APP_ORG_ID,
      repository_id: repositoryId,
      ref,
      iat: now,
      exp: now + 300,
    });
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      priv,
      new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  };

  it("accepts only main of the app's pinned repository", async () => {
    _resetJwksCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))),
    );
    const s = await setup();
    s.db.exec(
      "INSERT INTO app_repositories (app_id, repository_id, repository, pinned_at) VALUES ('books', '42', 'freeappstore-online/books', 0)",
    );
    const body = { ...SET, maxBytes: 10, replicas: 1 };
    expect(
      (await s.request('/sets', { method: 'POST', token: await oidc('43'), json: body })).status,
    ).toBe(403);
    expect(
      (
        await s.request('/sets', {
          method: 'POST',
          token: await oidc('42', 'refs/heads/dev'),
          json: body,
        })
      ).status,
    ).toBe(403);
    const ok = await s.request('/sets', { method: 'POST', token: await oidc('42'), json: body });
    expect(ok.status).toBe(201);
    expect(s.db.prepare('SELECT created_by FROM generation_sets').get()).toEqual({
      created_by: 'repo:freeappstore-online/books',
    });
  });
});

describe.skipIf(!hasSqlite)('community generation verification', () => {
  const TEXT = SENTENCE.repeat(3);
  const NARRATION = wav(10);
  const WAV_SET = { formats: ['audio/wav', 'audio/ogg', 'audio/mp4'], maxBytes: 1_000_000 };
  /** One claimed job of `text`, submitted by u2 with `file`; returns its row after verification. */
  async function run(
    s: Awaited<ReturnType<typeof setup>>,
    file: Uint8Array,
    o: { type?: string; text?: string; meta?: string; user?: string; setId?: string } = {},
  ) {
    const setId = o.setId ?? (await s.createSet(WAV_SET));
    await s.addJobs(setId, [{ key: 'k', input: { text: o.text ?? TEXT } }]);
    const user = o.user ?? 'u2';
    const job = (await s.claim(user, { setId }))!;
    const { submissionId } = await s.submissionId(
      await s.submit(user, job.id, job.leaseToken, {
        file,
        type: o.type ?? 'audio/wav',
        ...(o.meta ? { meta: o.meta } : {}),
      }),
    );
    await s.settled();
    return {
      setId,
      job,
      row: s.db
        .prepare(
          'SELECT status, reason, passed, duration_ms FROM generation_submissions WHERE id = ?',
        )
        .get(submissionId) as Record<string, unknown>,
    };
  }

  it('accepts a correct narration right after upload and publishes it', async () => {
    const s = await setup();
    const { setId, row } = await run(s, NARRATION);
    expect(row).toEqual({
      status: 'accepted',
      reason: null,
      passed: 1,
      duration_ms: 10_000,
    });
    const { artifacts } = (await (
      await s.request(`/sets/${setId}/manifest`, { user: null })
    ).json()) as {
      artifacts: { durationMs: number; url: string }[];
    };
    expect(artifacts[0]!.durationMs).toBe(10_000);
    const read = await app.request(artifacts[0]!.url, {}, s.env);
    // Deep equality on 320 KB is slow under load: compare bytes directly.
    const served = new Uint8Array(await read.arrayBuffer());
    expect(served.length === NARRATION.length && served.every((x, i) => x === NARRATION[i])).toBe(
      true,
    );
    expect([...s.objects.keys()].some((k) => k.startsWith('q/'))).toBe(false);
  });

  it('rejects a wrong format, truncation, a mislabelled content type and an implausible duration', async () => {
    const cases: [Uint8Array, string, RegExp][] = [
      [OGG, 'audio/wav', /does not match audio\/ogg/],
      [M4A.subarray(0, M4A.length - 500), 'audio/mp4', /truncated/],
      [NARRATION.subarray(0, 50_000), 'audio/wav', /truncated/],
      [NARRATION, 'audio/mp4', /does not match audio\/wav/],
      [wav(2), 'audio/wav', /too short/],
    ];
    for (const [file, type, reason] of cases) {
      const s = await setup();
      const { row, setId } = await run(s, file, { type });
      expect(row.status).toBe('rejected');
      expect(row.reason).toMatch(reason);
      expect(
        (
          (await (await s.request(`/sets/${setId}/manifest`, { user: null })).json()) as {
            artifacts: [];
          }
        ).artifacts,
      ).toEqual([]);
      // Rejected bytes leave quarantine; the contributor sees the reason.
      expect(s.objects.size).toBe(0);
      const mine = (await (await s.request('/submissions', { user: 'u2' })).json()) as {
        submissions: { status: string; reason: string }[];
      };
      expect(mine.submissions[0]!.reason).toMatch(reason);
      // The job is open again for someone else.
      expect(await s.claim('u3', { setId })).not.toBeNull();
    }
  });

  it('replicas: accepted only once enough distinct users agree; the earliest wins, the rest are superseded', async () => {
    const s = await setup();
    const setId = await s.createSet({ ...WAV_SET, replicas: 2 });
    await s.addJobs(setId, [{ key: 'k', input: { text: TEXT } }]);
    const a = (await s.claim('u2'))!;
    const b = (await s.claim('u3'))!;
    const first = await s.submissionId(
      await s.submit('u2', a.id, a.leaseToken, { file: NARRATION }),
    );
    await s.settled();
    expect(
      s.db
        .prepare('SELECT status, passed FROM generation_submissions WHERE id = ?')
        .get(first.submissionId),
    ).toEqual({ status: 'pending', passed: 1 });
    const second = await s.submissionId(
      await s.submit('u3', b.id, b.leaseToken, { file: wav(10.2) }),
    );
    await s.settled();
    const statuses = s.db
      .prepare('SELECT id, status FROM generation_submissions ORDER BY created_at')
      .all() as { id: string; status: string }[];
    expect(statuses.find((r) => r.id === first.submissionId)!.status).toBe('accepted');
    expect(statuses.find((r) => r.id === second.submissionId)!.status).toBe('superseded');
    expect(s.db.prepare('SELECT submission_id FROM generation_artifacts').get()).toEqual({
      submission_id: first.submissionId,
    });
    // Each sees only their own submission, with the measurements, the input and the job's artifact (#824).
    const mine = async (user: string) =>
      (
        (await (await s.request('/submissions', { user })).json()) as {
          submissions: {
            submissionId: string;
            status: string;
            durationMs: number | null;
            input: { text: string };
            artifact: { url: string; metaUrl: string | null } | null;
          }[];
        }
      ).submissions;
    const [winner, loser] = [await mine('u2'), await mine('u3')];
    expect(winner).toHaveLength(1);
    expect(loser).toHaveLength(1);
    expect(winner[0]).toMatchObject({
      submissionId: first.submissionId,
      status: 'accepted',
      durationMs: 10_000,
      input: { text: TEXT },
      artifact: { metaUrl: null },
    });
    expect(loser[0]).toMatchObject({
      submissionId: second.submissionId,
      status: 'superseded',
      input: { text: TEXT },
    });
    // A superseded submission still points at the job's accepted artifact: the winner's.
    expect(loser[0]!.artifact).toEqual(winner[0]!.artifact);
    const read = await app.request(winner[0]!.artifact!.url, {}, s.env);
    expect(read.status).toBe(200);
    expect((await read.arrayBuffer()).byteLength).toBe(NARRATION.length);
    expect(await mine('u4')).toEqual([]);
  });

  it('replicas that differ in duration by more than 15% disagree; the dissenter is rejected', async () => {
    const s = await setup();
    const setId = await s.createSet({ ...WAV_SET, replicas: 2 });
    await s.addJobs(setId, [{ key: 'k', input: { text: TEXT } }]);
    const a = (await s.claim('u2'))!;
    const b = (await s.claim('u3'))!;
    await s.submit('u2', a.id, a.leaseToken, { file: NARRATION });
    await s.settled();
    await s.submit('u3', b.id, b.leaseToken, { file: wav(12) });
    await s.settled();
    const rows = s.db
      .prepare('SELECT status, reason FROM generation_submissions ORDER BY created_at')
      .all() as { status: string; reason: string | null }[];
    expect(rows.map((r) => r.status)).toEqual(['pending', 'rejected']);
    expect(rows[1]!.reason).toBe('disagrees with other replicas');
  });

  it('a correct submission for an already accepted job is superseded and never overwrites', async () => {
    const s = await setup();
    const { job } = await run(s, NARRATION);
    const before = s.db.prepare('SELECT * FROM generation_artifacts').get();
    // An old lease that outlived acceptance (e.g. issued before replicas were met).
    s.db
      .prepare(
        "INSERT INTO generation_leases (job_id, user_id, app_id, token_hash, state, created_at, expires_at) VALUES (?, 'u3', 'books', ?, 'open', 0, ?)",
      )
      .run(job.id, await nativeHash(`glt_${'1'.repeat(64)}`), Date.now() + 60_000);
    const late = await s.submissionId(
      await s.submit('u3', job.id, `glt_${'1'.repeat(64)}`, { file: wav(10, true) }),
    );
    await s.settled();
    expect(late.status).toBe('superseded');
    expect(s.db.prepare('SELECT * FROM generation_artifacts').get()).toEqual(before);
  });

  it('a set language sets the zh band and is echoed by set, list, discovery and claim (#810)', async () => {
    const s = await setup();
    for (const language of ['', 'zh_CN', 'chinese-simplified-x', 7])
      expect(
        (
          await s.request('/sets', {
            method: 'POST',
            json: { ...SET, ...WAV_SET, replicas: 1, language },
          })
        ).status,
      ).toBe(400);
    const created = (await (
      await s.request('/sets', {
        method: 'POST',
        json: { ...SET, ...WAV_SET, replicas: 1, language: 'zh-Hans' },
      })
    ).json()) as { set: Record<string, unknown> };
    expect(created.set).toEqual(
      expect.objectContaining({
        language: 'zh-Hans',
        minCharsPerSecond: 2,
        maxCharsPerSecond: 9,
      }),
    );
    const setId = created.set.id as string;
    const listed = (await (await s.request('/sets')).json()) as { sets: { language: string }[] };
    expect(listed.sets[0]!.language).toBe('zh-Hans');
    await s.addJobs(setId, [{ key: 'k', input: { text: '对。' } }]);
    const token = await signSession('u2', KEY, { aud: 'console' });
    const open = (await (
      await app.request(
        '/v1/generation/open',
        { headers: { Authorization: `Bearer ${token}` } },
        s.env,
      )
    ).json()) as { apps: { sets: { language: string }[] }[] };
    expect(open.apps[0]!.sets[0]!.language).toBe('zh-Hans');
    const { row, job } = await run(s, wav(1.5), { setId, text: '对。' });
    expect((job as unknown as { language: string }).language).toBe('zh-Hans');
    expect(row).toEqual(expect.objectContaining({ status: 'accepted' }));
    // Explicit bands still win over the language's defaults.
    const own = (await (
      await s.request('/sets', {
        method: 'POST',
        json: { ...SET, ...WAV_SET, replicas: 1, language: 'zh', minCharsPerSecond: 1 },
      })
    ).json()) as { set: Record<string, unknown> };
    expect(own.set).toEqual(
      expect.objectContaining({ minCharsPerSecond: 1, maxCharsPerSecond: 9 }),
    );
  });

  it('stays pending when storage fails; the cron retries', async () => {
    const s = await setup();
    const get = s.env.GENERATED.get;
    s.env.GENERATED.get = async () => {
      throw new Error('R2 down');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { row } = await run(s, NARRATION);
    expect(row).toEqual(expect.objectContaining({ status: 'pending', passed: null }));
    s.env.GENERATED.get = get;
    expect(await verifyPending(s.env as never)).toBe(1);
    expect(s.db.prepare('SELECT status FROM generation_submissions').get()).toEqual({
      status: 'accepted',
    });
  });
});
