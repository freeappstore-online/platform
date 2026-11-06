/**
 * Route-level coverage for the OAuth / magic-link flows: session delivery,
 * browser binding of the OAuth state (#495), single-use state, the audience
 * minted per app_id, and the response modes accepted at /start.
 *
 * The unit tests in lib/deliver-session.test.ts cover the delivery helper;
 * these pin the wiring in routes/auth.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { s256Challenge } from '../lib/deliver-session.js';
import { signPayload, verifySession } from '../lib/session.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);
const API = 'https://api.freeappstore.online';
const VALID_RETURN_TO = 'https://demo.freeappstore.online/';
const VERIFIER = 'v'.repeat(43);

/** Permissive D1 stand-in, except that consumed_tokens is real: a second
 *  INSERT of the same hash throws like the UNIQUE index does. */
function fakeDB(): D1Database {
  const consumed = new Set<string>();
  const prepare = (sql: string): D1PreparedStatement => {
    let bound: unknown[] = [];
    const stmt: Partial<D1PreparedStatement> = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as D1PreparedStatement;
      },
      run: async <T = Record<string, unknown>>() => {
        if (sql.startsWith('INSERT INTO consumed_tokens')) {
          const hash = String(bound[0]);
          if (consumed.has(hash)) throw new Error('UNIQUE constraint failed');
          consumed.add(hash);
        }
        return { meta: { changes: 1 } } as unknown as D1Result<T>;
      },
      first: async <T = Record<string, unknown>>() => ({ id: `em:${'0'.repeat(32)}` }) as T,
    };
    return stmt as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeDB(),
    ROOM: {} as DurableObjectNamespace,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csec',
    SESSION_SIGNING_KEY: SIGNING_KEY,
    EMAIL: { send: async () => ({ messageId: 'test-message-id' }) },
    ...overrides,
  } as unknown as Env;
}

/** A magic-link token, which is the cheapest way to reach a real callback. */
function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return signPayload(
    {
      email: 'alice@example.com',
      appId: 'demo',
      returnTo: VALID_RETURN_TO,
      exp: Math.floor(Date.now() / 1000) + 60,
      ...overrides,
    },
    SIGNING_KEY,
  );
}

async function emailCallback(token: string, env = makeEnv()) {
  return app.request(
    `${API}/v1/auth/email/callback?token=${encodeURIComponent(token)}`,
    { redirect: 'manual' },
    env,
  );
}

const fragmentSession = (res: Response) =>
  decodeURIComponent((res.headers.get('location') ?? '').split('#fas_session=')[1] ?? '');

afterEach(() => vi.unstubAllGlobals());

describe('session delivery from the email callback', () => {
  it('delivers in the fragment with the app as audience', async () => {
    const res = await emailCallback(await makeToken());

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('#fas_session=');
    expect(location).not.toContain('?fas_session=');
    expect((await verifySession(fragmentSession(res), SIGNING_KEY))?.aud).toBe('demo');
  });

  it('ignores a stale responseMode in the link (always the fragment)', async () => {
    const res = await emailCallback(await makeToken({ responseMode: 'query' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').not.toContain('?fas_session=');
    expect(res.headers.get('location') ?? '').toContain('#fas_session=');

    const codeChallenge = await s256Challenge(VERIFIER);
    const coded = await emailCallback(await makeToken({ responseMode: 'code', codeChallenge }));
    expect(new URL(coded.headers.get('location') ?? '').searchParams.get('code')).toBeNull();
    expect(coded.headers.get('location') ?? '').toContain('#fas_session=');
  });

  it('refuses a link whose returnTo is not the app it was started for', async () => {
    const res = await emailCallback(
      await makeToken({ returnTo: 'https://attacker.freeappstore.online/' }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('returnTo not allowed');
  });

  it('mints aud=console for the storefront', async () => {
    const res = await emailCallback(
      await makeToken({ appId: 'store', returnTo: 'https://freeappstore.online/' }),
    );
    expect(res.status).toBe(302);
    expect((await verifySession(fragmentSession(res), SIGNING_KEY))?.aud).toBe('console');
  });
});

describe('/start parameters', () => {
  const startUrl = (params: Record<string, string>) =>
    `${API}/v1/auth/github/start?${new URLSearchParams({
      app_id: 'demo',
      return_to: VALID_RETURN_TO,
      ...params,
    })}`;

  it('rejects response_mode=code without a code_challenge', async () => {
    const res = await app.request(
      startUrl({ response_mode: 'code' }),
      { redirect: 'manual' },
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('code_challenge');
  });

  it('rejects a non-S256 challenge method', async () => {
    const res = await app.request(
      startUrl({
        response_mode: 'code',
        code_challenge: 'whatever',
        code_challenge_method: 'plain',
      }),
      { redirect: 'manual' },
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('S256');
  });

  it('redirects to the provider when a code-mode start is well formed', async () => {
    const res = await app.request(
      startUrl({
        response_mode: 'code',
        code_challenge: await s256Challenge(VERIFIER),
        code_challenge_method: 'S256',
      }),
      { redirect: 'manual' },
      makeEnv(),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('github.com/login/oauth/authorize');
  });

  it('rejects response_mode=query (#495)', async () => {
    const res = await app.request(
      startUrl({ response_mode: 'query' }),
      { redirect: 'manual' },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('response_mode');
  });

  it('rejects a return_to on another app subdomain, and a first-party id on an app subdomain', async () => {
    for (const params of [
      { app_id: 'demo', return_to: 'https://other.freeappstore.online/' },
      { app_id: 'console', return_to: 'https://demo.freeappstore.online/' },
      { app_id: 'store', return_to: 'https://demo.freeappstore.online/' },
    ]) {
      const res = await app.request(startUrl(params), { redirect: 'manual' }, makeEnv());
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('return_to not allowed');
    }
  });

  it('rejects a magic-link start that asks for a responseMode', async () => {
    const res = await app.request(
      `${API}/v1/auth/email/start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'pkce-check@example.com',
          appId: 'demo',
          returnTo: VALID_RETURN_TO,
          responseMode: 'code',
        }),
      },
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('responseMode');
  });
});

/** Drive /start and return what the callback needs: the signed state and the flow cookie. */
async function startGithub(env: Env, params: Record<string, string> = {}) {
  const res = await app.request(
    `${API}/v1/auth/github/start?${new URLSearchParams({
      app_id: 'demo',
      return_to: VALID_RETURN_TO,
      ...params,
    })}`,
    { redirect: 'manual' },
    env,
  );
  expect(res.status).toBe(302);
  const state = new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { state, setCookie, cookie: setCookie.split(';')[0] ?? '' };
}

function stubGithub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://github.com/login/oauth/access_token')) {
        return Response.json({ access_token: 'gho_x' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({ id: 7, login: 'alice', avatar_url: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

async function githubCallback(env: Env, state: string, cookie?: string) {
  return app.request(
    `${API}/v1/auth/github/callback?code=c&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: cookie ? { cookie } : {} },
    env,
  );
}

describe('OAuth state is bound to the browser and single-use (#495)', () => {
  it('sets a __Host- flow cookie at /start', async () => {
    const { setCookie } = await startGithub(makeEnv());
    expect(setCookie).toMatch(/^__Host-fas_oauth_[A-Za-z0-9_-]+=[A-Za-z0-9_-]+; /);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Max-Age=600');
  });

  it('completes with the cookie, delivers an app-scoped session and clears the cookie', async () => {
    const env = makeEnv();
    const { state, cookie } = await startGithub(env);
    stubGithub();

    const res = await githubCallback(env, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('#fas_session=');
    const payload = await verifySession(fragmentSession(res), SIGNING_KEY);
    expect(payload?.uid).toBe('gh:7');
    expect(payload?.aud).toBe('demo');
    expect(res.headers.get('set-cookie') ?? '').toMatch(/^__Host-fas_oauth_[^=]+=; .*Max-Age=0/);
  });

  it('refuses a callback without the flow cookie, before talking to the provider', async () => {
    const env = makeEnv();
    const { state } = await startGithub(env);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await githubCallback(env, state);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('different browser');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a cookie that carries another browser's secret", async () => {
    const env = makeEnv();
    const { state, cookie } = await startGithub(env);
    const name = cookie.split('=')[0];
    const res = await githubCallback(env, state, `${name}=${'z'.repeat(43)}`);
    expect(res.status).toBe(400);
  });

  it('refuses a replayed callback: the state is single-use', async () => {
    const env = makeEnv();
    const { state, cookie } = await startGithub(env);
    stubGithub();

    expect((await githubCallback(env, state, cookie)).status).toBe(302);
    const replay = await githubCallback(env, state, cookie);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('already used');
  });

  it('refuses a pre-#495 state with no nonce', async () => {
    const env = makeEnv();
    const legacy = await signPayload(
      { appId: 'demo', returnTo: VALID_RETURN_TO, exp: Math.floor(Date.now() / 1000) + 60 },
      SIGNING_KEY,
    );
    const res = await githubCallback(env, legacy);
    expect(res.status).toBe(400);
  });

  it('mints aud=console for the console on its own origin', async () => {
    const env = makeEnv();
    const { state, cookie } = await startGithub(env, {
      app_id: 'console',
      return_to: 'https://freeappstore.online/app/',
    });
    stubGithub();
    const res = await githubCallback(env, state, cookie);
    expect(res.status).toBe(302);
    expect((await verifySession(fragmentSession(res), SIGNING_KEY))?.aud).toBe('console');
  });

  it('uses a SameSite=None cookie for Apple, whose callback is a cross-site POST', async () => {
    const res = await app.request(
      `${API}/v1/auth/apple/start?${new URLSearchParams({ app_id: 'demo', return_to: VALID_RETURN_TO })}`,
      { redirect: 'manual' },
      makeEnv({
        APPLE_CLIENT_ID: 'online.freeappstore',
        APPLE_TEAM_ID: 'TEAM',
        APPLE_KEY_ID: 'KEY',
        APPLE_PRIVATE_KEY: btoa('not-a-real-key'),
      } as Partial<Env>),
    );
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^__Host-fas_oauth_/);
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
  });
});
