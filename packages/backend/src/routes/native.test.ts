/** Native companion (#616): pairing, grants, upload and app reads. Ported from PAS native.test.ts. */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { s256Challenge } from '../lib/deliver-session.js';
import {
  NATIVE_RETENTION_MS,
  nativeCatalog,
  nativeHash,
  nativePoints,
  pruneNativeData,
} from '../lib/native-companion.js';
import { isAllowedReturnTo } from '../lib/origins.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, type SqliteDb, sqliteD1 } from '../lib/sqlite-d1.testutil.js';

const KEY = 'a'.repeat(64);
const API = 'https://api.freeappstore.online';
let db: SqliteDb;
let env: { DB: D1Database; SESSION_SIGNING_KEY: string };

const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {},
) =>
  app.request(
    `${API}/v1${path}`,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
const rows = (sql: string) => db.prepare(sql).all();

async function pairing() {
  const verifier = 'b'.repeat(64);
  const start = await request('/native/auth/start', 'POST', {
    challenge: await nativeHash(verifier),
    label: 'iPhone (iOS 18.0)',
  });
  expect(start.status).toBe(200);
  const { id, authorizationUrl } = (await start.json()) as { id: string; authorizationUrl: string };
  expect(authorizationUrl).toBe(`${API}/v1/native/auth/authorize?id=${id}`);
  const auth = await request(`/native/auth/authorize?id=${id}`);
  expect(auth.status).toBe(200);
  const cookie = auth.headers.get('Set-Cookie')!.split(';')[0] as string;
  return { id, verifier, cookie, page: await auth.text() };
}

/** Stand in for the provider round trip: mint the one-time code the FAS flow would deliver. */
async function signIn(p: Awaited<ReturnType<typeof pairing>>, uid = 'gh:1') {
  const nonce = p.cookie.split('.')[1]!;
  const code = crypto.randomUUID();
  const session = await signSession(uid, KEY, { aud: 'console' });
  const challenge = await s256Challenge(await nativeHash(`pkce:${nonce}`));
  db.prepare(
    'INSERT INTO auth_codes (code_hash, session, app_id, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(await nativeHash(code), session, 'native', challenge, Math.floor(Date.now() / 1000) + 60);
  return code;
}

async function authorize(p: Awaited<ReturnType<typeof pairing>>, uid = 'gh:1') {
  const code = await signIn(p, uid);
  const callback = await request(
    `/native/auth/callback?code=${code}`,
    'GET',
    undefined,
    undefined,
    {
      Cookie: p.cookie,
    },
  );
  expect(callback.status).toBe(200);
  // Under no-referrer a real browser would POST the approve form with `Origin: null` (PAS #617).
  expect(callback.headers.get('Referrer-Policy')).toBe('same-origin');
  const nonce = (await callback.text()).match(/name="nonce" value="([a-f0-9]+)"/)![1]!;
  const result = await app.request(
    `${API}/v1/native/auth/approve`,
    {
      method: 'POST',
      headers: {
        Cookie: p.cookie,
        Origin: API,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `nonce=${nonce}`,
    },
    env,
  );
  expect(result.status).toBe(200);
}

async function device(uid = 'gh:1') {
  const p = await pairing();
  await authorize(p, uid);
  const response = await request('/native/auth/complete', 'POST', {
    id: p.id,
    verifier: p.verifier,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; deviceId: string };
}

async function grant(token: string, appId = 'run') {
  const me = (await (await request('/native/me', 'GET', undefined, token)).json()) as {
    apps: { id: string; version: string }[];
  };
  const response = await request(
    `/native/apps/${appId}/location`,
    'PUT',
    { version: me.apps.find((a) => a.id === appId)!.version, enabled: true },
    token,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { grant: { id: string; consent_at: number } }).grant;
}

const point = (id: string, at: number, grants: string[]) => ({
  id,
  at,
  lat: -33.86,
  lng: 151.2,
  accuracy: 5,
  grants,
});
const appToken = (uid: string, aud = 'run') => signSession(uid, KEY, { aud });
const pointIds = async (uid = 'gh:1') =>
  (
    (await (
      await request('/apps/run/native/locations', 'GET', undefined, await appToken(uid))
    ).json()) as {
      points: { id: string }[];
    }
  ).points.map((p) => p.id);

describe.skipIf(!hasSqlite)('FAS native companion', () => {
  beforeEach(() => {
    const s = sqliteD1();
    db = s.db;
    env = { DB: s.d1, SESSION_SIGNING_KEY: KEY };
    db.exec(`PRAGMA foreign_keys=ON;
      INSERT INTO users (id, github_id, github_login, created_at) VALUES ('gh:1', 1, 'alice', 0), ('gh:2', 2, 'bob', 0);
      INSERT INTO apps (id, owner_login, owner_id, created_at) VALUES ('run', 'alice', 'gh:1', 0), ('other', 'bob', 'gh:2', 0);`);
  });

  it('signs in through the FAS code flow with the native first-party return only', async () => {
    const p = await pairing();
    const link = new URL(
      p.page.match(/href="([^"]+github\/start[^"]+)"/)![1]!.replaceAll('&#38;', '&'),
    );
    expect(link.searchParams.get('app_id')).toBe('native');
    expect(link.searchParams.get('response_mode')).toBe('code');
    expect(link.searchParams.get('code_challenge_method')).toBe('S256');
    expect(isAllowedReturnTo(link.searchParams.get('return_to')!, 'native')).toBe(true);
    expect(isAllowedReturnTo(`${API}/v1/keys`, 'native')).toBe(false);
    expect(isAllowedReturnTo('https://run.freeappstore.online/', 'native')).toBe(false);
    // The PKCE verifier lives only behind the HttpOnly cookie, never in the page.
    expect(p.page).not.toContain(p.cookie.split('.')[1]!);
  });

  it('requires browser sign-in AND the initiating device proof; consumes approval once', async () => {
    const p = await pairing();
    expect(
      (await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status,
    ).toBe(202);
    expect(
      (await request('/native/auth/complete', 'POST', { id: p.id, verifier: 'c'.repeat(64) }))
        .status,
    ).toBe(403);
    await authorize(p);
    const result = (await (
      await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })
    ).json()) as { token: string };
    expect(result.token).toMatch(/^ndev_[a-f0-9]{64}$/);
    expect(rows('SELECT token_hash FROM native_devices')).not.toContainEqual({
      token_hash: result.token,
    });
    expect(
      (await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status,
    ).toBe(403);
    const me = (await (await request('/native/me', 'GET', undefined, result.token)).json()) as {
      user: { id: string; name: string };
      apps: { id: string; grant: unknown }[];
    };
    expect(me.user).toEqual({ id: 'gh:1', name: 'alice' });
    expect(me.apps.map((a) => [a.id, a.grant])).toEqual([['run', null]]);
  });

  it('rejects missing browser binding, a code for another verifier, foreign or null origins and malformed starts', async () => {
    expect((await request('/native/auth/start', 'POST', null)).status).toBe(400);
    expect((await request('/native/auth/start', 'POST', { label: 'x'.repeat(5000) })).status).toBe(
      413,
    );
    expect(
      (await request('/native/auth/start', 'POST', { challenge: 'bad', label: 'Phone' })).status,
    ).toBe(400);
    const p = await pairing();
    expect((await request('/native/auth/callback?code=bad')).status).toBe(403);
    // A real code minted for another browser's verifier does not sign this pairing in.
    const other = await pairing();
    const stolen = await signIn(other);
    expect(
      (
        await request(`/native/auth/callback?code=${stolen}`, 'GET', undefined, undefined, {
          Cookie: p.cookie,
        })
      ).status,
    ).toBe(401);
    // Signed in for real, the right nonce from a foreign or null Origin still cannot approve.
    const callback = await request(
      `/native/auth/callback?code=${await signIn(p)}`,
      'GET',
      undefined,
      undefined,
      {
        Cookie: p.cookie,
      },
    );
    const nonce = (await callback.text()).match(/name="nonce" value="([a-f0-9]+)"/)![1]!;
    for (const Origin of ['https://run.freeappstore.online', 'null']) {
      const approve = await app.request(
        `${API}/v1/native/auth/approve`,
        {
          method: 'POST',
          headers: {
            Cookie: p.cookie,
            Origin,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `nonce=${nonce}`,
        },
        env,
      );
      expect(approve.status).toBe(403);
    }
    expect(
      (await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status,
    ).toBe(202);
    db.exec('UPDATE native_pairings SET expires_at=0');
    expect(
      (await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status,
    ).toBe(403);
  });

  it('binds a pairing to the first browser that opens it; only that browser may reopen it (#634)', async () => {
    const p = await pairing();
    // Same browser reloads: same nonce, so the PKCE challenge and later sign-in still match.
    const reload = await request(`/native/auth/authorize?id=${p.id}`, 'GET', undefined, undefined, {
      Cookie: p.cookie,
    });
    expect(reload.status).toBe(200);
    expect(reload.headers.get('Set-Cookie')!.split(';')[0]).toBe(p.cookie);
    // Anyone else holding the link is refused, with or without a cookie of their own.
    const other = await request(`/native/auth/authorize?id=${p.id}`);
    expect(other.status).toBe(403);
    const forged = await request(`/native/auth/authorize?id=${p.id}`, 'GET', undefined, undefined, {
      Cookie: `${p.cookie.split('=')[0]}=${p.id}.${'c'.repeat(64)}`,
    });
    expect(forged.status).toBe(403);
    // The owner's browser still completes the flow.
    await authorize(p);
  });

  it('a deleted account cannot finish pairing', async () => {
    const p = await pairing();
    const code = await signIn(p, 'gh:9');
    expect(
      (
        await request(`/native/auth/callback?code=${code}`, 'GET', undefined, undefined, {
          Cookie: p.cookie,
        })
      ).status,
    ).toBe(401);
  });

  it('account deletion drops a pending pairing, so it never yields a device credential', async () => {
    const p = await pairing();
    await authorize(p);
    const del = await request('/auth/me', 'DELETE', undefined, await appToken('gh:1', 'console'));
    expect(del.status).toBe(200);
    expect(rows('SELECT * FROM native_pairings')).toHaveLength(0);
    expect(
      (await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status,
    ).toBe(403);
    // A pairing consumed just before the deletion lands still issues nothing.
    const q = await pairing();
    await authorize(q, 'gh:2');
    db.exec("DELETE FROM users WHERE id = 'gh:2'");
    expect(
      (await request('/native/auth/complete', 'POST', { id: q.id, verifier: q.verifier })).status,
    ).toBe(401);
    expect(rows('SELECT * FROM native_devices')).toHaveLength(0);
  });

  it('caps a streamed body without a Content-Length instead of buffering all of it', async () => {
    let pulled = 0;
    const large = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulled > 1000) controller.close();
        else controller.enqueue(new Uint8Array(1024).fill(32));
      },
    });
    const response = await app.request(
      `${API}/v1/native/auth/complete`,
      { method: 'POST', body: large, duplex: 'half' } as RequestInit,
      env,
    );
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it('stores only explicitly granted, post-consent points and makes retries idempotent', async () => {
    const d = await device();
    const g = await grant(d.token);
    const points = [
      point('valid', g.consent_at, [g.id]),
      point('old', g.consent_at - 1, [g.id]),
      point('unknown', g.consent_at, ['f'.repeat(64)]),
    ];
    for (let i = 0; i < 2; i++) {
      expect((await request('/native/locations', 'POST', { points }, d.token)).status).toBe(200);
    }
    expect(rows('SELECT point_id FROM native_locations')).toEqual([{ point_id: 'valid' }]);
  });

  it('reads only through a session delivered to that app: not console, other apps or the device token', async () => {
    const d = await device();
    const g = await grant(d.token);
    const bob = await device('gh:2');
    await request(
      '/native/locations',
      'POST',
      { points: [point('forged', Date.now(), [g.id])] },
      bob.token,
    );
    expect(rows('SELECT * FROM native_locations')).toHaveLength(0);
    await request(
      '/native/locations',
      'POST',
      { points: [point('mine', Date.now(), [g.id])] },
      d.token,
    );
    const read = (token: string) => request('/apps/run/native/locations', 'GET', undefined, token);
    expect((await read(await appToken('gh:1', 'console'))).status).toBe(403);
    expect((await read(await appToken('gh:1', 'other'))).status).toBe(403);
    expect((await read(d.token)).status).toBe(401);
    // A FAS session is never native permission.
    expect(
      (
        await request(
          '/native/apps/run/location',
          'PUT',
          { enabled: true, version: '1' },
          await appToken('gh:1'),
        )
      ).status,
    ).toBe(401);
    expect(await pointIds('gh:2')).toEqual([]);
    expect(await pointIds('gh:1')).toEqual(['mine']);
  });

  it('revokes history and rejects queued points after regrant or an owner change', async () => {
    const d = await device();
    const g = await grant(d.token);
    await request(
      '/native/locations',
      'POST',
      { points: [point('before', Date.now(), [g.id])] },
      d.token,
    );
    await request('/native/apps/run/location', 'DELETE', undefined, d.token);
    expect(rows('SELECT * FROM native_locations')).toHaveLength(0);
    const again = await grant(d.token);
    expect(again.id).not.toBe(g.id);
    await request(
      '/native/locations',
      'POST',
      { points: [point('queued', Date.now(), [g.id])] },
      d.token,
    );
    expect(rows('SELECT * FROM native_locations')).toHaveLength(0);
    db.exec("UPDATE apps SET owner_id='gh:2' WHERE id='run'");
    expect(rows('SELECT * FROM native_grants')).toHaveLength(0);
    await request(
      '/native/locations',
      'POST',
      { points: [point('moved', Date.now(), [again.id])] },
      d.token,
    );
    expect(rows('SELECT * FROM native_locations')).toHaveLength(0);
  });

  it('refuses apps outside the catalog, stale contracts, non-consent and malformed batches', async () => {
    const d = await device();
    expect(
      (
        await request(
          '/native/apps/other/location',
          'PUT',
          { version: '1', enabled: true },
          d.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request('/native/apps/run/location', 'PUT', { version: '0', enabled: true }, d.token))
        .status,
    ).toBe(400);
    expect(
      (await request('/native/apps/run/location', 'PUT', { version: '1', enabled: false }, d.token))
        .status,
    ).toBe(400);
    for (const points of [
      [],
      [point('x', Date.now(), [])],
      [point('x', 0, ['a'.repeat(64)])],
      [{ ...point('x', Date.now(), ['a'.repeat(64)]), lat: 91 }],
    ]) {
      expect((await request('/native/locations', 'POST', { points }, d.token)).status).toBe(400);
    }
    expect(() =>
      nativePoints(
        [point('x', Date.now(), ['a'.repeat(64)]), point('x', Date.now(), ['a'.repeat(64)])],
        Date.now(),
      ),
    ).toThrow();
  });

  it('disconnect, account deletion and app deletion remove grants and points', async () => {
    const d = await device();
    const g = await grant(d.token);
    await request(
      '/native/locations',
      'POST',
      { points: [point('x', Date.now(), [g.id])] },
      d.token,
    );
    expect((await request('/native/device', 'DELETE', undefined, d.token)).status).toBe(200);
    expect(rows('SELECT * FROM native_locations')).toHaveLength(0);
    expect((await request('/native/me', 'GET', undefined, d.token)).status).toBe(401);

    const e = await device();
    await grant(e.token);
    const del = await request('/auth/me', 'DELETE', undefined, await appToken('gh:1', 'console'));
    expect(del.status).toBe(200);
    expect(rows('SELECT * FROM native_devices')).toHaveLength(0);
    expect(rows('SELECT * FROM native_grants')).toHaveLength(0);

    const bob = await device('gh:2');
    db.exec("UPDATE apps SET owner_id='gh:2' WHERE id='run'");
    await grant(bob.token);
    db.exec("DELETE FROM apps WHERE id='run'");
    expect(rows('SELECT * FROM native_grants')).toHaveLength(0);
  });

  it('caps pairings per IP per day', async () => {
    const start = () =>
      request(
        '/native/auth/start',
        'POST',
        { challenge: 'b'.repeat(64), label: 'Phone' },
        undefined,
        {
          'cf-connecting-ip': '203.0.113.9',
        },
      );
    for (let i = 0; i < 30; i++) expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(429);
  });

  it('physically prunes expired points and device credentials', async () => {
    const d = await device();
    const g = await grant(d.token);
    await request(
      '/native/locations',
      'POST',
      { points: [point('x', Date.now(), [g.id])] },
      d.token,
    );
    await pruneNativeData(env.DB, Date.now() + NATIVE_RETENTION_MS + 1);
    expect(rows('SELECT * FROM native_locations')).toHaveLength(0);
    await pruneNativeData(env.DB, Date.now() + 100 * 24 * 60 * 60_000);
    expect(rows('SELECT * FROM native_devices')).toHaveLength(0);
  });

  describe('status read', () => {
    type Status = { available: boolean; enabled: boolean; lastPointAt: number | null };
    const statusOf = async (uid = 'gh:1') =>
      (await (
        await request('/apps/run/native/status', 'GET', undefined, await appToken(uid))
      ).json()) as Status;

    it('is gated like the locations read and reports apps outside the catalog as unavailable', async () => {
      const d = await device();
      expect(
        (
          await request(
            '/apps/run/native/status',
            'GET',
            undefined,
            await appToken('gh:1', 'other'),
          )
        ).status,
      ).toBe(403);
      expect((await request('/apps/run/native/status', 'GET', undefined, d.token)).status).toBe(
        401,
      );
      const other = await request(
        '/apps/other/native/status',
        'GET',
        undefined,
        await appToken('gh:2', 'other'),
      );
      expect(await other.json()).toEqual({ available: false, enabled: false, lastPointAt: null });
    });

    it('tracks grant, upload, revocation and device expiry, per user', async () => {
      expect(await statusOf()).toEqual({ available: true, enabled: false, lastPointAt: null });
      const d = await device();
      const g = await grant(d.token);
      expect(await statusOf()).toEqual({ available: true, enabled: true, lastPointAt: null });
      const at = Date.now();
      await request('/native/locations', 'POST', { points: [point('p1', at, [g.id])] }, d.token);
      expect(await statusOf()).toEqual({ available: true, enabled: true, lastPointAt: at });
      expect((await statusOf('gh:2')).enabled).toBe(false);
      await request('/native/apps/run/location', 'DELETE', undefined, d.token);
      expect((await statusOf()).enabled).toBe(false);
      await grant(d.token);
      db.exec('UPDATE native_devices SET expires_at=0');
      expect((await statusOf()).enabled).toBe(false);
    });
  });

  it('pins the Run contract version: a wording edit revokes every grant and must fail here', async () => {
    const versions = Object.fromEntries((await nativeCatalog()).map((a) => [a.id, a.version]));
    expect(versions).toEqual({ run: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(versions.run).toMatchInlineSnapshot(
      `"45fae68e723f523567b070f54ed8f14fa041983025133a32c0a32b1b17fc2d7e"`,
    );
  });
});
