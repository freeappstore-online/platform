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

/** Sign in with a link through the confirmation page's same-origin POST (#514). */
async function emailCallback(token: string, env = makeEnv(), site = 'same-origin') {
  return app.request(
    `${API}/v1/auth/email/callback`,
    {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': site },
      body: new URLSearchParams({ token }).toString(),
    },
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

describe('magic link bound to the requesting browser (#514)', () => {
  /** POST /email/start from `origin`; returns the emailed token and any flow cookie. */
  async function startEmail(env: Env, origin = 'https://demo.freeappstore.online') {
    const send = vi.fn().mockResolvedValue({ messageId: 'm' });
    const res = await app.request(
      `${API}/v1/auth/email/start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({
          email: `bind-${crypto.randomUUID()}@example.com`,
          appId: 'demo',
          returnTo: VALID_RETURN_TO,
        }),
      },
      { ...env, EMAIL: { send } } as Env,
    );
    expect(res.status).toBe(200);
    const link = new URL(/https:\/\/\S+callback\?token=\S+/.exec(send.mock.calls[0]![0].text)![0]);
    const setCookie = res.headers.get('set-cookie') ?? '';
    return {
      token: link.searchParams.get('token') ?? '',
      setCookie,
      cookie: setCookie.split(';')[0]!,
    };
  }

  const openLink = (env: Env, token: string, cookie?: string) =>
    app.request(
      `${API}/v1/auth/email/callback?token=${encodeURIComponent(token)}`,
      { redirect: 'manual', headers: cookie ? { cookie } : {} },
      env,
    );

  it('sets a __Host- flow cookie when the app itself asks, and credentialed CORS allows it', async () => {
    const { setCookie } = await startEmail(makeEnv());
    expect(setCookie).toMatch(
      /^__Host-fas_oauth_[^=]+=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Secure/,
    );

    const preflight = await app.request(
      `${API}/v1/auth/email/start`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://demo.freeappstore.online',
          'Access-Control-Request-Method': 'POST',
        },
      },
      makeEnv(),
    );
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      'https://demo.freeappstore.online',
    );
  });

  it('binds at most five pending links per browser', async () => {
    const flows = Array.from({ length: 5 }, (_, i) => `__Host-fas_oauth_n${i}=s`).join('; ');
    const send = vi.fn().mockResolvedValue({ messageId: 'm' });
    const res = await app.request(
      `${API}/v1/auth/email/start`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://demo.freeappstore.online',
          cookie: flows,
        },
        body: JSON.stringify({
          email: 'many@example.com',
          appId: 'demo',
          returnTo: VALID_RETURN_TO,
        }),
      },
      makeEnv({ EMAIL: { send } } as Partial<Env>),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sets no cookie when another origin asks for the link', async () => {
    const { setCookie } = await startEmail(makeEnv(), 'https://evil.freeappstore.online');
    expect(setCookie).toBe('');
  });

  it('same browser: signs in directly and clears the cookie', async () => {
    const env = makeEnv();
    const { token, cookie } = await startEmail(env);
    const res = await openLink(env, token, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('#fas_session=');
    expect(res.headers.get('set-cookie') ?? '').toMatch(/^__Host-fas_oauth_[^=]+=; .*Max-Age=0/);
  });

  it('other browser: shows a confirmation page, unframeable, that consumes nothing', async () => {
    const env = makeEnv();
    const { token, cookie } = await startEmail(env);
    const page = await openLink(env, token);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toMatch(
      /Continue signing in as <strong>bind-[\w-]+@example\.com<\/strong> to <strong>demo<\/strong>/,
    );
    expect(html).toContain('<form method="post" action="/v1/auth/email/callback">');
    expect(page.headers.get('referrer-policy')).toBe('same-origin');

    // A wrong cookie for the same nonce is no better than none.
    const wrong = await openLink(env, token, `${cookie.split('=')[0]}=not-the-secret`);
    expect(wrong.status).toBe(200);

    // The page consumed nothing: the button still signs in.
    const confirmed = await emailCallback(token, env);
    expect(confirmed.status).toBe(302);
    expect(confirmed.headers.get('location') ?? '').toContain('#fas_session=');
  });

  it('replay: a used link is refused, through either path', async () => {
    const env = makeEnv();
    const { token, cookie } = await startEmail(env);
    expect((await openLink(env, token, cookie)).status).toBe(302);
    const again = await openLink(env, token, cookie);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('already used');
    expect((await emailCallback(token, env)).status).toBe(400);
  });

  it('cross-site POST: refused without consuming the link', async () => {
    const env = makeEnv();
    const { token } = await startEmail(env);
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await emailCallback(token, env, site);
      expect(res.status).toBe(403);
    }
    // No Sec-Fetch-Site (an older browser): the Origin must be the API's own.
    const noOrigin = await app.request(
      `${API}/v1/auth/email/callback`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://evil.example',
        },
        body: new URLSearchParams({ token }).toString(),
      },
      env,
    );
    expect(noOrigin.status).toBe(403);
    expect((await emailCallback(token, env)).status).toBe(302);
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
