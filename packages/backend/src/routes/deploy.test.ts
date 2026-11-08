import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { _resetJwksCache } from '../lib/github-oidc.js';
import { hasSqlite, type SqliteDb, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import {
  APP_DEPLOY_WORKFLOW,
  APP_DEPLOY_WORKFLOW_SHAS,
  APP_ORG_ID,
  contentTypeFor,
  DEFAULT_LIMITS,
  DEPLOY_AUDIENCE,
  limitsFor,
  pruneDeploys,
  setDeployLimits,
} from './deploy.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const KID = 'deploy-test';
const ROUTES_SQL = `CREATE TABLE routes (slug TEXT NOT NULL, zone TEXT NOT NULL, r2_prefix TEXT NOT NULL,
  store TEXT NOT NULL, hosted_on TEXT NOT NULL DEFAULT 'r2', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, release TEXT, PRIMARY KEY (slug, zone))`;

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
    kid: KID,
  } as JsonWebKey;
});

let jtiSeq = 0;
/** A GitHub Actions token for `repo` (repository_id `repoId`) in freeappstore-online. */
async function oidc(repo: string, repoId: string, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64json({ alg: 'RS256', typ: 'JWT', kid: KID });
  const p = b64json({
    iss: ISSUER,
    aud: DEPLOY_AUDIENCE,
    sub: `repo:freeappstore-online/${repo}:ref:refs/heads/main`,
    repository: `freeappstore-online/${repo}`,
    repository_owner: 'freeappstore-online',
    repository_owner_id: APP_ORG_ID,
    repository_id: repoId,
    ref: 'refs/heads/main',
    event_name: 'push',
    workflow_ref: `freeappstore-online/${repo}/.github/workflows/deploy.yml@refs/heads/main`,
    job_workflow_ref: `${APP_DEPLOY_WORKFLOW}@${[...APP_DEPLOY_WORKFLOW_SHAS][0]}`,
    sha: 'abc1234',
    run_id: '1',
    jti: `jti-${++jtiSeq}`,
    iat: now,
    nbf: now,
    exp: now + 300,
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    priv,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, body: ReadableStream | string | null) {
      const bytes =
        typeof body === 'string'
          ? new TextEncoder().encode(body)
          : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        body: new Response(bytes).body,
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...objects]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, v]) => ({ key, size: v.byteLength })),
        truncated: false,
      };
    },
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) objects.delete(k);
    },
  };
  return { objects, bucket: bucket as unknown as R2Bucket };
}

describe.skipIf(!hasSqlite)('keyless deploys (/v1/deploys)', () => {
  let db: SqliteDb;
  let d1: D1Database;
  let store: ReturnType<typeof memoryBucket>;
  const env = () => ({ DB: d1, APPS_BUCKET: store.bucket });

  beforeEach(() => {
    _resetJwksCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))),
    );
    ({ db, d1 } = sqliteD1());
    db.exec(ROUTES_SQL);
    for (const id of ['alpha', 'beta']) {
      db.prepare(
        "INSERT INTO apps (id, owner_login, created_at, store) VALUES (?, 'serge-ivo', 1, 'apps')",
      ).run(id);
      db.prepare(
        "INSERT INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES (?, 'freeappstore.online', ?, 'apps', 1, 1)",
      ).run(id, `apps/${id}`);
    }
    store = memoryBucket();
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = async (token: string, files: Record<string, number>) =>
    app.request(
      '/v1/deploys',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      },
      env(),
    );
  const put = (id: string, token: string, path: string, body: string) =>
    app.request(
      `/v1/deploys/${id}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(body.length) },
        body,
      },
      env(),
    );
  const commit = (id: string, token: string) =>
    app.request(
      `/v1/deploys/${id}/commit`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env(),
    );
  const release = (slug: string) =>
    (
      db.prepare('SELECT release FROM routes WHERE slug = ?').get(slug) as {
        release: string | null;
      }
    ).release;

  async function deploy(repo: string, repoId: string, files: Record<string, string>) {
    const sizes = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, b.length]));
    const res = await open(await oidc(repo, repoId), sizes);
    expect(res.status).toBe(201);
    const session = (await res.json()) as { id: string; token: string; app_id: string };
    for (const [p, b] of Object.entries(files))
      expect((await put(session.id, session.token, p, b)).status).toBe(204);
    return { session, committed: await commit(session.id, session.token) };
  }

  it('uploads under the app release prefix, then switches the route atomically', async () => {
    const { session, committed } = await deploy('alpha', '101', {
      'index.html': '<script src="/assets/a.js"></script>',
      'assets/a.js': 'x',
      'my photo.png': 'p',
      '.vcqa/report.json': '{}',
    });
    expect(committed.status).toBe(200);
    expect(session.app_id).toBe('alpha');
    expect(release('alpha')).toBe(session.id);
    expect(store.objects.has(`apps/alpha/.r/${session.id}/assets/a.js`)).toBe(true);
    expect(store.objects.has(`apps/alpha/.r/${session.id}/my photo.png`)).toBe(true);
    expect(store.objects.has('apps/alpha/.vcqa/report.json')).toBe(true);
    expect([...store.objects.keys()].every((k) => k.startsWith('apps/alpha/'))).toBe(true);
  });

  it('keeps the previous release for rollback and deletes older ones', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await deploy('alpha', '101', { 'index.html': `v${i}` })).session.id);
    expect(release('alpha')).toBe(ids[2]);
    const has = (id: string) => store.objects.has(`apps/alpha/.r/${id}/index.html`);
    // Within the grace a page cached before the switch can still load v0.
    expect(has(ids[0]!)).toBe(true);
    db.prepare('UPDATE app_deploys SET committed_at = committed_at - 3600000').run();
    expect(await pruneDeploys(env() as never)).toBe(1);
    expect(has(ids[0]!)).toBe(false);
    expect(has(ids[1]!) && has(ids[2]!)).toBe(true);
  });

  it('a session pruned while it commits can never become the release', async () => {
    const s = (await (await open(await oidc('alpha', '101'), { 'index.html': 1 })).json()) as {
      id: string;
      token: string;
    };
    await put(s.id, s.token, 'index.html', 'x');
    db.prepare("UPDATE app_deploys SET status = 'deleted' WHERE id = ?").run(s.id);
    expect((await commit(s.id, s.token)).status).toBe(409);
    expect(release('alpha')).toBeNull();
  });

  it('never serves a half-uploaded deploy', async () => {
    await deploy('alpha', '101', { 'index.html': 'old' });
    const live = release('alpha');
    const res = await open(await oidc('alpha', '101'), { 'index.html': 3, 'assets/b.js': 1 });
    const s = (await res.json()) as { id: string; token: string };
    await put(s.id, s.token, 'index.html', 'new');
    expect((await commit(s.id, s.token)).status).toBe(409);
    expect(release('alpha')).toBe(live);
  });

  describe('repository A can never write app B', () => {
    beforeEach(async () => {
      await deploy('alpha', '101', { 'index.html': 'a' });
      await deploy('beta', '202', { 'index.html': 'b' });
    });

    it('a repo renamed to B still deploys only to the app its id is pinned to', async () => {
      const { session } = await deploy('beta', '101', { 'index.html': 'evil' });
      expect(session.app_id).toBe('alpha');
      expect(
        new TextDecoder().decode(store.objects.get(`apps/beta/.r/${release('beta')}/index.html`)),
      ).toBe('b');
    });

    it('a recreated or reused repo name with a different repository_id is refused', async () => {
      const res = await open(await oidc('beta', '999'), { 'index.html': 1 });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/another repository/);
    });

    it("A's upload token cannot write into B's deploy, and paths cannot climb out", async () => {
      const a = (await (await open(await oidc('alpha', '101'), { 'index.html': 1 })).json()) as {
        id: string;
        token: string;
      };
      const b = (await (await open(await oidc('beta', '202'), { 'index.html': 1 })).json()) as {
        id: string;
        token: string;
      };
      expect((await put(b.id, a.token, 'index.html', 'x')).status).toBe(401);
      const climb = await app.request(
        `/v1/deploys/${a.id}/files/..%2F..%2Fbeta%2Findex.html`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${a.token}`, 'Content-Length': '1' },
          body: 'x',
        },
        env(),
      );
      expect(climb.status).toBe(400);
      expect(
        (await open(await oidc('alpha', '101'), { '../beta/index.html': 1, 'index.html': 1 }))
          .status,
      ).toBe(400);
      expect(
        (await open(await oidc('alpha', '101'), { '/etc/x.html': 1, 'index.html': 1 })).status,
      ).toBe(400);
    });
  });

  it.each([
    ['another org', { repository_owner_id: '1', repository_owner: 'evil' }, 403],
    ['a branch other than main', { ref: 'refs/heads/feature' }, 403],
    ['a pull_request event', { event_name: 'pull_request' }, 403],
    [
      "the repo's own inline deploy.yml (#559)",
      {
        job_workflow_ref: 'freeappstore-online/alpha/.github/workflows/deploy.yml@refs/heads/main',
      },
      403,
    ],
    [
      'another workflow in the repo',
      {
        job_workflow_ref: 'freeappstore-online/alpha/.github/workflows/sneaky.yml@refs/heads/main',
      },
      403,
    ],
    [
      'a workflow from another repo',
      { job_workflow_ref: 'freeappstore-online/beta/.github/workflows/deploy.yml@refs/heads/main' },
      403,
    ],
    ['another audience', { aud: 'https://api.proappstore.online' }, 401],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 120 }, 401],
    ['a not-yet-valid token', { nbf: Math.floor(Date.now() / 1000) + 600 }, 401],
  ])('refuses %s', async (_name, claims, status) => {
    expect((await open(await oidc('alpha', '101', claims), { 'index.html': 1 })).status).toBe(
      status,
    );
  });

  describe('the platform app deploy workflow (#559)', () => {
    const sha = [...APP_DEPLOY_WORKFLOW_SHAS][0]!;
    const called = (claims: Record<string, unknown> = {}) =>
      oidc('alpha', '101', {
        workflow_ref: 'freeappstore-online/alpha/.github/workflows/deploy.yml@refs/heads/main',
        job_workflow_ref: `${APP_DEPLOY_WORKFLOW}@${sha}`,
        ...claims,
      });

    it('accepts the listed commit called from the repo deploy.yml on main', async () => {
      const res = await open(await called(), { 'index.html': 1 });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { app_id: string }).app_id).toBe('alpha');
    });

    it.each([
      ['an unlisted commit', { job_workflow_ref: `${APP_DEPLOY_WORKFLOW}@${'0'.repeat(40)}` }],
      ['a branch of the workflow', { job_workflow_ref: `${APP_DEPLOY_WORKFLOW}@refs/heads/main` }],
      [
        'another workflow in the repo calling it',
        { workflow_ref: 'freeappstore-online/alpha/.github/workflows/sneaky.yml@refs/heads/main' },
      ],
      [
        'a caller in another repo',
        { workflow_ref: 'freeappstore-online/beta/.github/workflows/deploy.yml@refs/heads/main' },
      ],
      ['a look-alike workflow path', { job_workflow_ref: `${APP_DEPLOY_WORKFLOW}.evil@${sha}` }],
    ])('refuses %s', async (_name, claims) => {
      expect((await open(await called(claims), { 'index.html': 1 })).status).toBe(403);
    });
  });

  it('accepts an apps.repo recorded as a GitHub URL, and refuses another repo', async () => {
    db.prepare(
      "UPDATE apps SET repo = 'https://github.com/freeappstore-online/alpha' WHERE id = 'alpha'",
    ).run();
    expect((await open(await oidc('alpha', '101'), { 'index.html': 1 })).status).toBe(201);
    db.prepare(
      "UPDATE apps SET repo = 'https://github.com/someone/beta.git' WHERE id = 'beta'",
    ).run();
    expect((await open(await oidc('beta', '202'), { 'index.html': 1 })).status).toBe(403);
  });

  describe('platform monorepo sites', () => {
    const wf = (name: string) =>
      `freeappstore-online/platform/.github/workflows/${name}@refs/heads/main`;
    beforeEach(() => {
      db.prepare(
        "INSERT INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES ('console', 'freeappstore.online', 'apps/console', 'apps', 1, 1)",
      ).run();
    });

    it('deploys the console from deploy-console.yml only', async () => {
      const ok = await oidc('platform', '900', { job_workflow_ref: wf('deploy-console.yml') });
      const res = await open(ok, { 'index.html': 1 });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { app_id: string }).app_id).toBe('console');
    });

    it.each([
      ['deploy.yml', 'deploy.yml'],
      ['another platform workflow', 'deploy-admin.yml'],
    ])('refuses %s in the platform repo', async (_n, name) => {
      const token = await oidc('platform', '900', { job_workflow_ref: wf(name) });
      expect((await open(token, { 'index.html': 1 })).status).toBe(403);
    });

    it('refuses another repo claiming the console workflow', async () => {
      const token = await oidc('alpha', '101', { job_workflow_ref: wf('deploy-console.yml') });
      expect((await open(token, { 'index.html': 1 })).status).toBe(403);
    });
  });

  describe('delta upload and per-app limits (#544)', () => {
    const hex = (c: string) => c.repeat(64);
    const openDelta = async (
      repo: string,
      repoId: string,
      files: Record<string, string>,
      hashes: Record<string, string>,
    ) => {
      const sizes = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, b.length]));
      const res = await app.request(
        '/v1/deploys',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await oidc(repo, repoId)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: sizes, hashes }),
        },
        env(),
      );
      return res;
    };
    const reuse = (id: string, token: string, paths: string[]) =>
      app.request(
        `/v1/deploys/${id}/reuse`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths }),
        },
        env(),
      );
    type Session = { id: string; token: string; missing: string[]; reuse: string[] };

    async function deployDelta(files: Record<string, string>, hashes: Record<string, string>) {
      const res = await openDelta('alpha', '101', files, hashes);
      expect(res.status).toBe(201);
      const session = (await res.json()) as Session;
      for (const path of session.missing)
        expect((await put(session.id, session.token, path, files[path]!)).status).toBe(204);
      if (session.reuse.length)
        expect((await reuse(session.id, session.token, session.reuse)).status).toBe(204);
      const committed = await commit(session.id, session.token);
      return { session, committed };
    }

    it('uploads everything the first time, then only what changed', async () => {
      const v1 = { 'index.html': '<a>', 'big.pdf': 'x'.repeat(50), 'a.js': 'one' };
      const h1 = { 'index.html': hex('a'), 'big.pdf': hex('b'), 'a.js': hex('c') };
      const first = await deployDelta(v1, h1);
      expect(first.session.reuse).toEqual([]);
      expect(first.session.missing.sort()).toEqual(Object.keys(v1).sort());
      expect(first.committed.status).toBe(200);

      const v2 = { ...v1, 'a.js': 'two' };
      const second = await deployDelta(v2, { ...h1, 'a.js': hex('d') });
      expect(second.session.missing).toEqual(['a.js']);
      expect(second.session.reuse.sort()).toEqual(['big.pdf', 'index.html']);
      expect(second.committed.status).toBe(200);
      expect(release('alpha')).toBe(second.session.id);
      const at = (path: string) =>
        new TextDecoder().decode(store.objects.get(`apps/alpha/.r/${second.session.id}/${path}`));
      expect(at('big.pdf')).toBe('x'.repeat(50));
      expect(at('a.js')).toBe('two');
      expect(at('index.html')).toBe('<a>');
    });

    it('a same-size file with a different hash is uploaded again', async () => {
      await deployDelta({ 'index.html': 'aaa' }, { 'index.html': hex('a') });
      const res = await openDelta(
        'alpha',
        '101',
        { 'index.html': 'bbb' },
        { 'index.html': hex('b') },
      );
      const session = (await res.json()) as Session;
      expect(session.missing).toEqual(['index.html']);
      expect(session.reuse).toEqual([]);
    });

    it('will not copy a path that is not on the reuse list, nor leave the release incomplete', async () => {
      await deployDelta(
        { 'index.html': 'aaa', 'b.js': 'bbb' },
        { 'index.html': hex('a'), 'b.js': hex('b') },
      );
      const res = await openDelta(
        'alpha',
        '101',
        { 'index.html': 'aaa', 'b.js': 'ccc' },
        { 'index.html': hex('a'), 'b.js': hex('c') },
      );
      const s = (await res.json()) as Session;
      expect((await reuse(s.id, s.token, ['b.js'])).status).toBe(400);
      // index.html neither uploaded nor copied: commit refuses
      expect((await put(s.id, s.token, 'b.js', 'ccc')).status).toBe(204);
      expect((await commit(s.id, s.token)).status).toBe(409);
      expect((await reuse(s.id, s.token, ['index.html'])).status).toBe(204);
      expect((await commit(s.id, s.token)).status).toBe(200);
    });

    it("never reuses another app's files", async () => {
      await deployDelta({ 'index.html': 'aaa' }, { 'index.html': hex('a') });
      const res = await app.request(
        '/v1/deploys',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await oidc('beta', '202')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: { 'index.html': 3 }, hashes: { 'index.html': hex('a') } }),
        },
        env(),
      );
      const s = (await res.json()) as Session;
      expect(s.reuse).toEqual([]);
      expect(s.missing).toEqual(['index.html']);
    });

    it('rejects malformed hashes', async () => {
      const res = await openDelta(
        'alpha',
        '101',
        { 'index.html': 'aaa' },
        { 'index.html': 'nothex' },
      );
      expect(res.status).toBe(400);
      const stray = await openDelta(
        'alpha',
        '101',
        { 'index.html': 'aaa' },
        { 'other.js': hex('a') },
      );
      expect(stray.status).toBe(400);
    });

    it('still serves a client that sends no hashes (the pinned fleet workflow)', async () => {
      const { session, committed } = await deploy('alpha', '101', { 'index.html': 'old client' });
      expect(committed.status).toBe(200);
      expect(session).not.toHaveProperty('missing');
    });

    it('prunes the stored manifest with its release', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const files = { 'index.html': `v${i}` };
        ids.push((await deployDelta(files, { 'index.html': hex(String(i)) })).session.id);
      }
      expect(store.objects.has(`apps/alpha/.d/${ids[0]}.json`)).toBe(true);
      db.prepare('UPDATE app_deploys SET committed_at = committed_at - 3600000').run();
      await pruneDeploys(env() as never);
      expect(store.objects.has(`apps/alpha/.d/${ids[0]}.json`)).toBe(false);
      expect(store.objects.has(`apps/alpha/.d/${ids[2]}.json`)).toBe(true);
    });

    it('keeps a busy session open past 15 minutes, up to a cap', async () => {
      const files = { 'index.html': 'a', 'b.js': 'b' };
      const res = await openDelta('alpha', '101', files, {
        'index.html': hex('a'),
        'b.js': hex('b'),
      });
      const s = (await res.json()) as Session;
      const expiry = () =>
        (
          db.prepare('SELECT expires_at FROM app_deploys WHERE id = ?').get(s.id) as {
            expires_at: number;
          }
        ).expires_at;
      // 14 minutes in: a file extends the session by another 15
      db.prepare(
        'UPDATE app_deploys SET created_at = created_at - 840000, expires_at = ? WHERE id = ?',
      ).run(Date.now() + 60000, s.id);
      expect((await put(s.id, s.token, 'index.html', 'a')).status).toBe(204);
      expect(expiry()).toBeGreaterThan(Date.now() + 10 * 60000);
      // past the 3 hour cap it cannot extend, and then expires
      db.prepare(
        'UPDATE app_deploys SET created_at = created_at - 11000000, expires_at = ? WHERE id = ?',
      ).run(Date.now() + 60000, s.id);
      expect((await put(s.id, s.token, 'b.js', 'b')).status).toBe(204);
      expect(expiry()).toBeLessThan(Date.now() + 15 * 60000 - 1000 * 60 * 5);
    });

    it('keeps the default limits, and an override raises them for that app only', async () => {
      expect(await limitsFor(d1, 'alpha')).toEqual(DEFAULT_LIMITS);
      const big = DEFAULT_LIMITS.fileBytes + 1;
      const tooBig = async (repo: string, id: string) =>
        (
          await app.request(
            '/v1/deploys',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${await oidc(repo, id)}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ files: { 'index.html': 1, 'big.pdf': big } }),
            },
            env(),
          )
        ).status;
      expect(await tooBig('alpha', '101')).toBe(413);
      const set = await setDeployLimits(d1, 'alpha', { max_file_bytes: big }, 'serge-ivo');
      expect(set).toEqual({ ...DEFAULT_LIMITS, fileBytes: big });
      expect(await tooBig('alpha', '101')).toBe(201);
      expect(await tooBig('beta', '202')).toBe(413);
    });

    it('validates an override and needs a real app', async () => {
      await expect(setDeployLimits(d1, 'alpha', { max_files: 0 }, 'x')).rejects.toThrow(
        /max_files/,
      );
      await expect(setDeployLimits(d1, 'alpha', { max_file_bytes: 1e12 }, 'x')).rejects.toThrow();
      await expect(setDeployLimits(d1, 'nope', { max_files: 5 }, 'x')).rejects.toThrow(/no app/);
    });

    it('grants scoreplay its override in migration 0040', async () => {
      expect(
        (
          db.prepare("SELECT max_files FROM app_deploy_limits WHERE app_id='scoreplay'").get() as {
            max_files: number;
          }
        ).max_files,
      ).toBe(20000);
    });
  });

  it('refuses an unregistered repository', async () => {
    expect((await open(await oidc('gamma', '303'), { 'index.html': 1 })).status).toBe(403);
  });

  it('refuses a replayed token (jti)', async () => {
    const token = await oidc('alpha', '101');
    expect((await open(token, { 'index.html': 1 })).status).toBe(201);
    expect((await open(token, { 'index.html': 1 })).status).toBe(409);
  });

  it('rate-limits deploys per app', async () => {
    const insert = db.prepare(
      `INSERT INTO app_deploys (id, app_id, jti, repository_id, token_hash, manifest, total_bytes,
         status, created_at, expires_at) VALUES (?, 'alpha', ?, '101', 'h', '{}', 0, 'deleted', ?, 0)`,
    );
    for (let i = 0; i < 20; i++) insert.run(`old${i}`, `old-jti-${i}`, Date.now() - 1000);
    expect((await open(await oidc('alpha', '101'), { 'index.html': 1 })).status).toBe(429);
    expect((await open(await oidc('beta', '202'), { 'index.html': 1 })).status).toBe(201);
  });

  it('caps uncommitted uploads per app', async () => {
    for (let i = 0; i < 3; i++)
      expect((await open(await oidc('alpha', '101'), { 'index.html': 1 })).status).toBe(201);
    const res = await open(await oidc('alpha', '101'), { 'index.html': 1 });
    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/already uploading/);
  });

  it('an older run that commits after a newer one cannot replace it', async () => {
    const older = (await (await open(await oidc('alpha', '101'), { 'index.html': 3 })).json()) as {
      id: string;
      token: string;
    };
    await put(older.id, older.token, 'index.html', 'old');
    const { session } = await deploy('alpha', '101', { 'index.html': 'new' });
    expect((await commit(older.id, older.token)).status).toBe(409);
    expect(release('alpha')).toBe(session.id);
  });

  it('the daily prune drops abandoned uploads but never a served release', async () => {
    const { session } = await deploy('alpha', '101', { 'index.html': 'live' });
    const s = (await (await open(await oidc('alpha', '101'), { 'index.html': 4 })).json()) as {
      id: string;
      token: string;
    };
    await put(s.id, s.token, 'index.html', 'half');
    db.prepare('UPDATE app_deploys SET expires_at = 0 WHERE id = ?').run(s.id);
    expect(await pruneDeploys(env() as never)).toBe(1);
    expect(store.objects.has(`apps/alpha/.r/${s.id}/index.html`)).toBe(false);
    expect(store.objects.has(`apps/alpha/.r/${session.id}/index.html`)).toBe(true);
  });

  it('refuses oversize files, wrong lengths and files outside the manifest', async () => {
    expect(
      (await open(await oidc('alpha', '101'), { 'index.html': 1, 'big.bin': 26 * 1024 * 1024 }))
        .status,
    ).toBe(413);
    const s = (await (await open(await oidc('alpha', '101'), { 'index.html': 5 })).json()) as {
      id: string;
      token: string;
    };
    expect((await put(s.id, s.token, 'index.html', 'abc')).status).toBe(400);
    expect((await put(s.id, s.token, 'other.js', 'abcde')).status).toBe(400);
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/app-1a2b.js', 'text/javascript; charset=utf-8'],
    ['.well-known/assetlinks.json', 'application/json'],
    ['.buildinfo.json', 'application/json'],
    ['CNAME', 'application/octet-stream'],
    ['sounds/hit.OGG', 'audio/ogg'],
    ["fonts/Café Noir's #1 [b].woff2", 'font/woff2'],
    ['models/brain.onnx', 'application/octet-stream'],
  ])('allows %s', (path, type) => expect(contentTypeFor(path)).toBe(type));
  it.each([
    '../x.html',
    'a/../b.js',
    '/abs.js',
    'a//b.js',
    'a\\b.js',
    'run.sh',
    'x.php',
    'a/./b.js',
    '',
  ])('refuses %s', (path) => expect(contentTypeFor(path)).toBeNull());
});
