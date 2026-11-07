import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { _resetJwksCache } from '../lib/github-oidc.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, type SqliteDb, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import { APP_ORG_ID, DEPLOY_AUDIENCE } from './deploy.js';
import {
  AUDIT_AUDIENCE,
  AUDIT_WORKFLOW_REF,
  PLATFORM_REPO_ID,
  READS_PER_HOUR,
} from './fleet-audit.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const KID = 'audit-test';
const SIGNING_KEY = 'a'.repeat(64);
const ROUTES_SQL = `CREATE TABLE routes (slug TEXT NOT NULL, zone TEXT NOT NULL, r2_prefix TEXT NOT NULL,
  store TEXT NOT NULL, hosted_on TEXT NOT NULL DEFAULT 'r2', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, release TEXT, PRIMARY KEY (slug, zone))`;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const b64json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

const rsa = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};
let priv: CryptoKey;
let otherPriv: CryptoKey;
let jwk: JsonWebKey;
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(rsa, true, ['sign', 'verify'])) as CryptoKeyPair;
  otherPriv = ((await crypto.subtle.generateKey(rsa, true, ['sign', 'verify'])) as CryptoKeyPair)
    .privateKey;
  priv = pair.privateKey;
  jwk = {
    ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey),
    kid: KID,
  } as JsonWebKey;
});

/** The audit workflow's token, with `claims` overriding any of it. */
async function oidc(claims: Record<string, unknown> = {}, key: CryptoKey = priv) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64json({ alg: 'RS256', typ: 'JWT', kid: KID });
  const p = b64json({
    iss: ISSUER,
    aud: AUDIT_AUDIENCE,
    sub: 'repo:freeappstore-online/platform:ref:refs/heads/main',
    repository: 'freeappstore-online/platform',
    repository_owner: 'freeappstore-online',
    repository_owner_id: APP_ORG_ID,
    repository_id: PLATFORM_REPO_ID,
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    job_workflow_ref: AUDIT_WORKFLOW_REF,
    iat: now,
    nbf: now,
    exp: now + 300,
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

describe.skipIf(!hasSqlite)('fleet audit endpoint (/v1/audit/apps)', () => {
  let db: SqliteDb;
  let d1: D1Database;
  const env = () => ({ DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY, ADMIN_USER_IDS: 'admin-1' });
  const get = (token?: string, path = '/v1/audit/apps') =>
    app.request(path, token ? { headers: { Authorization: `Bearer ${token}` } } : {}, env());
  const reads = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM fleet_audit_reads').get() as { n: number }).n;

  beforeEach(() => {
    _resetJwksCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))),
    );
    ({ db, d1 } = sqliteD1());
    db.exec(ROUTES_SQL);
    db.exec('DELETE FROM apps');
    const insertApp = db.prepare(
      'INSERT INTO apps (id, owner_login, created_at, store, repo) VALUES (?, ?, 1, ?, ?)',
    );
    insertApp.run('alpha', 'secret-owner', 'apps', 'https://github.com/freeappstore-online/alpha');
    insertApp.run('beta', 'secret-owner', 'apps', null);
    insertApp.run(
      'chess',
      'secret-owner',
      'games',
      'https://github.com/freegamestore-online/chess',
    );
    const insertRoute = db.prepare(
      "INSERT INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES (?, ?, ?, 'apps', 1, 1)",
    );
    insertRoute.run('alpha', 'freeappstore.online', 'apps/alpha');
    insertRoute.run('orphan', 'freeappstore.online', 'apps/orphan');
    insertRoute.run('chess', 'freegamestore.online', 'games/chess');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the minimal shape to the audit workflow, FAS apps only', async () => {
    const res = await get(await oidc());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      apps: [
        {
          id: 'alpha',
          repo: 'https://github.com/freeappstore-online/alpha',
          r2Prefix: 'apps/alpha',
        },
        { id: 'beta', repo: null, r2Prefix: null },
      ],
      routesWithoutApps: ['orphan'],
    });
    expect(text).not.toContain('secret-owner');
  });

  it('accepts a scheduled run', async () => {
    expect((await get(await oidc({ event_name: 'schedule' }))).status).toBe(200);
  });

  const refused: Array<[string, () => Promise<string | undefined>, number, string]> = [
    ['no token', async () => undefined, 401, 'missing_token'],
    ['a junk token', async () => 'not.a.jwt', 403, 'invalid_token'],
    ['a bad signature', async () => await oidc({}, otherPriv), 403, 'bad_signature'],
    [
      'an expired token',
      async () => await oidc({ exp: Math.floor(Date.now() / 1000) - 10 }),
      403,
      'expired',
    ],
    ['the wrong audience', async () => await oidc({ aud: 'x' }), 403, 'wrong_audience'],
    [
      'the deploy audience',
      async () => await oidc({ aud: DEPLOY_AUDIENCE }),
      403,
      'wrong_audience',
    ],
    [
      'another repository id',
      async () => await oidc({ repository_id: '1' }),
      403,
      'wrong_repository',
    ],
    [
      'no repository id',
      async () => await oidc({ repository_id: undefined }),
      403,
      'wrong_repository',
    ],
    ['another owner id', async () => await oidc({ repository_owner_id: '1' }), 403, 'wrong_owner'],
    [
      'another workflow ref',
      async () =>
        await oidc({
          job_workflow_ref:
            'freeappstore-online/platform/.github/workflows/deploy-console.yml@refs/heads/main',
        }),
      403,
      'wrong_workflow',
    ],
    [
      'the audit workflow on another branch',
      async () =>
        await oidc({
          job_workflow_ref:
            'freeappstore-online/platform/.github/workflows/fleet-consistency-audit.yml@refs/heads/x',
        }),
      403,
      'wrong_workflow',
    ],
    ['a non-main ref', async () => await oidc({ ref: 'refs/heads/x' }), 403, 'wrong_ref'],
    ['a disallowed event', async () => await oidc({ event_name: 'push' }), 403, 'wrong_event'],
    [
      'a pull request event',
      async () => await oidc({ event_name: 'pull_request' }),
      403,
      'wrong_event',
    ],
  ];
  it.each(refused)('refuses %s', async (_name, token, status, code) => {
    const res = await get(await token());
    expect(res.status).toBe(status);
    expect(((await res.json()) as { code: string }).code).toBe(code);
    expect(reads()).toBe(0);
  });

  it('refuses a FAS session', async () => {
    for (const aud of ['console', 'sdk']) {
      const session = await signSession('admin-1', SIGNING_KEY, { aud });
      expect((await get(session)).status).toBe(403);
    }
  });

  it('is not an admin or session credential: the audit token fails /v1/admin/apps and /v1/auth/me', async () => {
    const token = await oidc();
    for (const path of ['/v1/admin/apps', '/v1/admin/users', '/v1/auth/me']) {
      const res = await get(token, path);
      expect([401, 403]).toContain(res.status);
    }
  });

  it('rate limits to a small number of reads per hour', async () => {
    const token = await oidc();
    for (let i = 0; i < READS_PER_HOUR; i++) expect((await get(token)).status).toBe(200);
    const res = await get(token);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('rate_limited');
    // Reads older than an hour no longer count.
    db.prepare('UPDATE fleet_audit_reads SET read_at = read_at - 3700000').run();
    expect((await get(token)).status).toBe(200);
  });
});
