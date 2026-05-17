import { Google, generateCodeVerifier, generateState, decodeIdToken } from 'arctic';
import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import { isAllowedReturnTo } from '../lib/origins.js';
import { signPayload, signSession, verifyPayload } from '../lib/session.js';
import type { Env } from '../types.js';

interface OAuthState {
  appId: string;
  returnTo: string;
  exp: number;
}

interface GoogleOAuthState {
  appId: string;
  returnTo: string;
  codeVerifier: string;
  exp: number;
}

const STATE_TTL_SECONDS = 10 * 60;

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get('/auth/github/start', async (c) => {
  const appId = c.req.query('app_id') ?? '';
  const returnTo = c.req.query('return_to') ?? '';
  if (!appId || !returnTo) return c.text('missing app_id or return_to', 400);
  if (!isAllowedReturnTo(returnTo)) return c.text('return_to not allowed', 400);

  const state = await signPayload<OAuthState>(
    { appId, returnTo, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS },
    c.env.SESSION_SIGNING_KEY,
  );
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', new URL('/v1/auth/github/callback', c.req.url).toString());
  return c.redirect(url.toString());
});

authRoutes.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code');
  const stateRaw = c.req.query('state');
  if (!code || !stateRaw) return c.text('missing code or state', 400);

  const state = await verifyPayload<OAuthState>(stateRaw, c.env.SESSION_SIGNING_KEY);
  if (!state) return c.text('invalid state', 400);
  if (state.exp < Math.floor(Date.now() / 1000)) return c.text('state expired', 400);
  if (!isAllowedReturnTo(state.returnTo)) return c.text('return_to not allowed', 400);

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tok = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tok.access_token) return c.text(`github oauth: ${tok.error ?? 'unknown'}`, 400);

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'freeappstore-api',
    },
  });
  if (!userRes.ok) return c.text('failed to fetch github user', 502);
  const ghUser = (await userRes.json()) as {
    id: number;
    login: string;
    avatar_url: string | null;
  };

  const userId = `gh:${ghUser.id}`;
  await c.env.DB.prepare(
    `INSERT INTO users (id, github_id, github_login, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       avatar_url = excluded.avatar_url`,
  )
    .bind(userId, ghUser.id, ghUser.login, ghUser.avatar_url, Date.now())
    .run();

  const session = await signSession(userId, c.env.SESSION_SIGNING_KEY);
  const redirect = new URL(state.returnTo);
  redirect.hash = `fas_session=${encodeURIComponent(session)}`;
  return c.redirect(redirect.toString());
});

authRoutes.get('/auth/google/start', async (c) => {
  const appId = c.req.query('app_id') ?? '';
  const returnTo = c.req.query('return_to') ?? '';
  if (!appId || !returnTo) return c.text('missing app_id or return_to', 400);
  if (!isAllowedReturnTo(returnTo)) return c.text('return_to not allowed', 400);

  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text('Google OAuth not configured', 503);
  }

  const redirectUri = new URL('/v1/auth/google/callback', c.req.url).toString();
  const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, redirectUri);

  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  const signedState = await signPayload<GoogleOAuthState>(
    { appId, returnTo, codeVerifier, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS },
    c.env.SESSION_SIGNING_KEY,
  );

  const url = google.createAuthorizationURL(signedState, codeVerifier, ['openid', 'profile', 'email']);
  return c.redirect(url.toString());
});

authRoutes.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code');
  const stateRaw = c.req.query('state');
  if (!code || !stateRaw) return c.text('missing code or state', 400);

  const state = await verifyPayload<GoogleOAuthState>(stateRaw, c.env.SESSION_SIGNING_KEY);
  if (!state) return c.text('invalid state', 400);
  if (state.exp < Math.floor(Date.now() / 1000)) return c.text('state expired', 400);
  if (!isAllowedReturnTo(state.returnTo)) return c.text('return_to not allowed', 400);

  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text('Google OAuth not configured', 503);
  }

  const redirectUri = new URL('/v1/auth/google/callback', c.req.url).toString();
  const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, redirectUri);

  try {
    const tokens = await google.validateAuthorizationCode(code, state.codeVerifier);
    const claims = decodeIdToken(tokens.idToken()) as {
      sub: string;
      name?: string;
      email?: string;
      picture?: string;
    };

    const userId = `google:${claims.sub}`;
    const login = claims.email ? claims.email.split('@')[0] : claims.sub;
    const displayName = claims.name ?? login;

    await c.env.DB.prepare(
      `INSERT INTO users (id, github_id, github_login, avatar_url, created_at, provider, provider_id, email, display_name)
       VALUES (?, 0, ?, ?, ?, 'google', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         avatar_url = excluded.avatar_url,
         email = excluded.email,
         display_name = excluded.display_name`,
    )
      .bind(userId, login, claims.picture ?? null, Date.now(), claims.sub, claims.email ?? null, displayName)
      .run();

    const session = await signSession(userId, c.env.SESSION_SIGNING_KEY);
    const redirect = new URL(state.returnTo);
    redirect.hash = `fas_session=${encodeURIComponent(session)}`;
    return c.redirect(redirect.toString());
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    return c.text(`Google sign-in failed: ${err instanceof Error ? err.message : 'unknown error'}`, 500);
  }
});

authRoutes.get('/auth/me', async (c) => {
  try {
    const user = await requireUser(c);
    return c.json(user);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});
