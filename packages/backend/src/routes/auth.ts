import { Apple, decodeIdToken, Google } from 'arctic';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  HttpError,
  isAdminLogin,
  isAdminUserId,
  requireConsoleUser,
  requireUser,
} from '../lib/auth.js';
import {
  deliverSession,
  exchangeAuthCode,
  isClientState,
  isResponseMode,
} from '../lib/deliver-session.js';
import { escapeHtml, isLikelyEmail, normalizeEmail, sendEmail } from '../lib/email.js';
import { isAllowedReturnTo, sessionAudience } from '../lib/origins.js';
import { d1UsageStore, dayKey } from '../lib/proxy-rate-limit.js';
import {
  b64urlBytes,
  newAccountSessionMark,
  scopeRolesToAudience,
  signPayload,
  signSession,
  verifyPayload,
} from '../lib/session.js';
import type { Env } from '../types.js';

/**
 * The signed state every provider round-trip carries. `nonce` names the flow
 * cookie and `bh` is the SHA-256 of that cookie's secret (#495): the callback
 * is accepted only from the browser that started the flow, so a captured
 * callback URL cannot log a victim into an attacker's account (login CSRF).
 * The state is also single-use (consumed_tokens).
 */
interface OAuthState {
  appId: string;
  returnTo: string;
  responseMode?: 'code';
  codeChallenge?: string;
  clientState?: string;
  nonce: string;
  bh: string;
  exp: number;
}

/**
 * `nonce` / `bh` bind the link to the browser that asked for it, exactly as
 * OAuthState does (#514). They are absent when the request could not carry
 * the cookie (another origin, a third-party-cookie context): such a link, like
 * one opened in another browser, asks the user to confirm before signing in.
 */
interface EmailMagicState {
  email: string;
  appId: string;
  returnTo: string;
  clientState?: string;
  nonce?: string;
  bh?: string;
  exp: number;
}

/**
 * Validate the PKCE parameters on a /start request. Only `response_mode=code`
 * uses them, and for that mode they are mandatory — a code-mode flow started
 * without a challenge would have nothing binding the eventual code to its
 * initiator, so it is rejected here rather than at the callback (by which
 * point the user has already been through the provider).
 */
function readCodeChallenge(
  responseMode: string | undefined,
  codeChallenge: string | undefined,
  method: string | undefined,
): { ok: true; codeChallenge?: string } | { ok: false; error: string } {
  if (responseMode !== 'code') return { ok: true };
  if (!codeChallenge) return { ok: false, error: 'response_mode=code requires code_challenge' };
  if (method && method !== 'S256') {
    return { ok: false, error: 'code_challenge_method must be S256' };
  }
  return { ok: true, codeChallenge };
}

const STATE_TTL_SECONDS = 10 * 60;
const MAGIC_LINK_TTL_SECONDS = 15 * 60;
const MAX_PENDING_LINK_COOKIES = 5;

// Per-recipient throttle for magic-link sends. The 60 s cooldown is a
// per-isolate fast path; the daily caps below are the real control, counted in
// D1 so they hold across isolates and colos (#472). Stops an unauthenticated
// caller from email-bombing a victim address / burning the email quota.
const EMAIL_SEND_COOLDOWN_MS = 60_000;
// Counted only after a send succeeded, per address+IP so a third party cannot
// use up a victim's allowance from another IP (#570); the absolute per-address
// ceiling stays higher to still bound mail to one inbox.
const MAGIC_LINKS_PER_ADDRESS_PER_IP_PER_DAY = 10;
const MAGIC_LINKS_PER_ADDRESS_PER_DAY = 50;
const MAGIC_LINKS_PER_IP_PER_DAY = 100;
const emailSendMap = new Map<string, number>();

export const authRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

// ── flow cookie ─────────────────────────────────────────────────
// Same scheme as workers/mcp/src/auth-handler.ts: `__Host-` (which requires
// Secure) in production; the bare name over http so `wrangler dev` works.
// One cookie per pending flow, named by its nonce, so two sign-ins started in
// the same browser (two tabs) do not overwrite each other's secret.

const COOKIE_BASE = 'fas_oauth';

function isSecure(url: string): boolean {
  return new URL(url).protocol === 'https:';
}

function cookieName(url: string, nonce: string): string {
  const name = `${COOKIE_BASE}_${nonce}`;
  return isSecure(url) ? `__Host-${name}` : name;
}

/**
 * `sameSite: 'none'` is for Apple only: its callback is a cross-site POST
 * (form_post), which a Lax cookie would not accompany.
 */
function flowCookie(
  url: string,
  nonce: string,
  value: string,
  sameSite: 'Lax' | 'None',
  maxAge: number,
): string {
  const secure = isSecure(url) || sameSite === 'None';
  return [
    `${cookieName(url, nonce)}=${value}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    ...(secure ? ['Secure'] : []),
    `Max-Age=${maxAge}`,
  ].join('; ');
}

function readFlowCookie(c: Ctx, nonce: string): string | null {
  const header = c.req.header('cookie');
  if (!header) return null;
  const name = cookieName(c.req.url, nonce);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** How many flow cookies (any provider) this request carries. */
function countFlowCookies(c: Ctx): number {
  const header = c.req.header('cookie') ?? '';
  return header.split(';').filter((part) => /^\s*(__Host-)?fas_oauth_[^=]*=/.test(part)).length;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlBytes(bytes);
}

/**
 * The part of every provider /start that is the same: validate app_id /
 * return_to / response_mode / PKCE, mint the flow nonce + browser secret, and
 * sign the state. The caller adds provider specifics (Google's PKCE verifier)
 * before signing, so this returns the unsigned claims.
 */
async function beginFlow(
  c: Ctx,
  sameSite: 'Lax' | 'None',
): Promise<
  { ok: true; claims: OAuthState; cookie: string; secret: string } | { ok: false; res: Response }
> {
  const appId = c.req.query('app_id') ?? '';
  const returnTo = c.req.query('return_to') ?? '';
  const responseMode = c.req.query('response_mode');
  if (!appId || !returnTo) return { ok: false, res: c.text('missing app_id or return_to', 400) };
  if (!isAllowedReturnTo(returnTo, appId)) {
    return { ok: false, res: c.text('return_to not allowed', 400) };
  }
  if (!isResponseMode(responseMode)) {
    return { ok: false, res: c.text('response_mode must be omitted or "code"', 400) };
  }
  const pkce = readCodeChallenge(
    responseMode,
    c.req.query('code_challenge'),
    c.req.query('code_challenge_method'),
  );
  if (!pkce.ok) return { ok: false, res: c.text(pkce.error, 400) };
  const clientState = c.req.query('client_state');
  if (clientState !== undefined && !isClientState(clientState)) {
    return { ok: false, res: c.text('invalid client_state', 400) };
  }

  const nonce = randomToken();
  const secret = randomToken();
  const claims: OAuthState = {
    appId,
    returnTo,
    ...(responseMode ? { responseMode } : {}),
    ...(pkce.codeChallenge ? { codeChallenge: pkce.codeChallenge } : {}),
    ...(clientState ? { clientState } : {}),
    nonce,
    bh: await sha256Hex(secret),
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };
  return {
    ok: true,
    claims,
    secret,
    cookie: flowCookie(c.req.url, nonce, secret, sameSite, STATE_TTL_SECONDS),
  };
}

/**
 * Google's PKCE verifier, derived from the browser-bound flow secret (which
 * lives only in the HttpOnly cookie) so it never travels in the signed,
 * readable state.
 */
function googleCodeVerifier(secret: string): Promise<string> {
  return sha256Hex(`pkce:${secret}`);
}

/** Redirect to the provider with the flow cookie riding along. */
function redirectWithCookie(location: string, cookie: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Set-Cookie': cookie } });
}

/**
 * The part of every provider callback that is the same: the state must
 * verify, be unexpired, name an allowed return_to, match this browser's flow
 * cookie, and never have been seen before.
 */
async function verifyFlow<T extends OAuthState>(
  c: Ctx,
  stateRaw: string,
): Promise<{ ok: true; state: T } | { ok: false; res: Response }> {
  const state = await verifyPayload<T>(stateRaw, c.env.SESSION_SIGNING_KEY);
  if (!state) return { ok: false, res: c.text('invalid state', 400) };
  if (typeof state.exp !== 'number' || state.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, res: c.text('state expired', 400) };
  }
  if (!isAllowedReturnTo(state.returnTo, state.appId)) {
    return { ok: false, res: c.text('return_to not allowed', 400) };
  }
  // Browser binding: a state signed before #495 has no nonce and is refused.
  const secret = typeof state.nonce === 'string' ? readFlowCookie(c, state.nonce) : null;
  if (!secret || typeof state.bh !== 'string' || (await sha256Hex(secret)) !== state.bh) {
    return {
      ok: false,
      res: c.text('this sign-in was started in a different browser — start again', 400),
    };
  }
  // Single-use: same table and pattern as the magic link below.
  try {
    await c.env.DB.prepare('INSERT INTO consumed_tokens (hash, expires_at) VALUES (?, ?)')
      .bind(await sha256Hex(stateRaw), state.exp)
      .run();
  } catch {
    return { ok: false, res: c.text('state already used — start again', 400) };
  }
  return { ok: true, state };
}

/** Mint the session for `userId` and hand it back per the state, clearing the flow cookie. */
async function finishFlow(
  c: Ctx,
  state: OAuthState,
  userId: string,
  roles: { roles: string[]; appRoles: Record<string, string[]> },
  sameSite: 'Lax' | 'None',
): Promise<Response> {
  const session = await signSession(userId, c.env.SESSION_SIGNING_KEY, {
    ...roles,
    aud: sessionAudience(state.appId),
  });
  const delivery = await deliverSession(c.env, state, session);
  if (!delivery.ok) return c.text(delivery.error, 400);
  return new Response(null, {
    status: 302,
    headers: {
      Location: delivery.url,
      'Set-Cookie': flowCookie(c.req.url, state.nonce, '', sameSite, 0),
    },
  });
}

authRoutes.get('/auth/github/start', async (c) => {
  const flow = await beginFlow(c, 'Lax');
  if (!flow.ok) return flow.res;
  const state = await signPayload<OAuthState>(flow.claims, c.env.SESSION_SIGNING_KEY);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', new URL('/v1/auth/github/callback', c.req.url).toString());
  return redirectWithCookie(url.toString(), flow.cookie);
});

authRoutes.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code');
  const stateRaw = c.req.query('state');
  if (!code || !stateRaw) return c.text('missing code or state', 400);

  const flow = await verifyFlow<OAuthState>(c, stateRaw);
  if (!flow.ok) return flow.res;
  const { state } = flow;

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
  // A new row starts its sessions_valid_after at now (every insert below does
  // the same): an account deleted and signed up again must not revive the
  // tokens issued to it before the deletion (#495). ON CONFLICT leaves it.
  await c.env.DB.prepare(
    `INSERT INTO users (id, github_id, github_login, avatar_url, created_at, sessions_valid_after)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       avatar_url = excluded.avatar_url`,
  )
    .bind(userId, ghUser.id, ghUser.login, ghUser.avatar_url, Date.now(), newAccountSessionMark())
    .run();

  const roles = await computeRoles(userId, ghUser.login, c.env);
  return finishFlow(c, state, userId, roles, 'Lax');
});

authRoutes.get('/auth/google/start', async (c) => {
  const flow = await beginFlow(c, 'Lax');
  if (!flow.ok) return flow.res;

  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text('Google OAuth not configured', 503);
  }

  const redirectUri = new URL('/v1/auth/google/callback', c.req.url).toString();
  const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, redirectUri);

  const signedState = await signPayload<OAuthState>(flow.claims, c.env.SESSION_SIGNING_KEY);

  const url = google.createAuthorizationURL(signedState, await googleCodeVerifier(flow.secret), [
    'openid',
    'profile',
    'email',
  ]);
  return redirectWithCookie(url.toString(), flow.cookie);
});

authRoutes.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code');
  const stateRaw = c.req.query('state');
  if (!code || !stateRaw) return c.text('missing code or state', 400);

  const flow = await verifyFlow<OAuthState>(c, stateRaw);
  if (!flow.ok) return flow.res;
  const { state } = flow;

  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text('Google OAuth not configured', 503);
  }

  const redirectUri = new URL('/v1/auth/google/callback', c.req.url).toString();
  const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, redirectUri);

  try {
    // verifyFlow already required this browser's flow cookie, so it is present.
    const secret = readFlowCookie(c, state.nonce) as string;
    const tokens = await google.validateAuthorizationCode(code, await googleCodeVerifier(secret));
    const claims = decodeIdToken(tokens.idToken()) as {
      sub: string;
      name?: string;
      email?: string;
      picture?: string;
    };

    const userId = `google:${claims.sub}`;
    // Never the email local part (#434): the login and display name reach
    // every app and room peer. A new account gets a neutral name; the name
    // Google supplies wins when present, and an existing name is kept.
    const login = neutralDisplayName();
    const providerName = claims.name ?? null;

    await c.env.DB.prepare(
      `INSERT INTO users (id, github_id, github_login, avatar_url, created_at, provider, provider_id, email, display_name, sessions_valid_after)
       VALUES (?, 0, ?, ?, ?, 'google', ?, ?, COALESCE(?, ?), ?)
       ON CONFLICT(id) DO UPDATE SET
         avatar_url = excluded.avatar_url,
         email = excluded.email,
         display_name = COALESCE(?, users.display_name)`,
    )
      .bind(
        userId,
        login,
        claims.picture ?? null,
        Date.now(),
        claims.sub,
        claims.email ?? null,
        providerName,
        login,
        newAccountSessionMark(),
        providerName,
      )
      .run();

    const roles = await computeRoles(userId, login, c.env, 'google');
    return await finishFlow(c, state, userId, roles, 'Lax');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    return c.text('Google sign-in failed. Please try again.', 500);
  }
});

// ---------------------------------------------------------------------------
// Apple Sign In
// ---------------------------------------------------------------------------

authRoutes.get('/auth/apple/start', async (c) => {
  const flow = await beginFlow(c, 'None');
  if (!flow.ok) return flow.res;

  if (
    !c.env.APPLE_CLIENT_ID ||
    !c.env.APPLE_TEAM_ID ||
    !c.env.APPLE_KEY_ID ||
    !c.env.APPLE_PRIVATE_KEY
  ) {
    return c.text('Apple Sign In not configured', 503);
  }

  const redirectUri = new URL('/v1/auth/apple/callback', c.req.url).toString();
  const privateKeyBytes = Uint8Array.from(atob(c.env.APPLE_PRIVATE_KEY), (ch) => ch.charCodeAt(0));
  const apple = new Apple(
    c.env.APPLE_CLIENT_ID,
    c.env.APPLE_TEAM_ID,
    c.env.APPLE_KEY_ID,
    privateKeyBytes,
    redirectUri,
  );

  const signedState = await signPayload<OAuthState>(flow.claims, c.env.SESSION_SIGNING_KEY);

  const url = apple.createAuthorizationURL(signedState, ['name', 'email']);
  return redirectWithCookie(url.toString(), flow.cookie);
});

/**
 * Apple callback is a POST (form_post response_mode).
 * Apple sends user info (name, email) in the request body only on first sign-in.
 */
authRoutes.post('/auth/apple/callback', async (c) => {
  const body = await c.req.parseBody();
  const code = body.code as string | undefined;
  const stateRaw = body.state as string | undefined;
  const userJson = body.user as string | undefined; // only on first sign-in

  if (!code || !stateRaw) return c.text('missing code or state', 400);

  const flow = await verifyFlow<OAuthState>(c, stateRaw);
  if (!flow.ok) return flow.res;
  const { state } = flow;

  if (
    !c.env.APPLE_CLIENT_ID ||
    !c.env.APPLE_TEAM_ID ||
    !c.env.APPLE_KEY_ID ||
    !c.env.APPLE_PRIVATE_KEY
  ) {
    return c.text('Apple Sign In not configured', 503);
  }

  const redirectUri = new URL('/v1/auth/apple/callback', c.req.url).toString();
  const privateKeyBytes = Uint8Array.from(atob(c.env.APPLE_PRIVATE_KEY), (ch) => ch.charCodeAt(0));
  const apple = new Apple(
    c.env.APPLE_CLIENT_ID,
    c.env.APPLE_TEAM_ID,
    c.env.APPLE_KEY_ID,
    privateKeyBytes,
    redirectUri,
  );

  try {
    const tokens = await apple.validateAuthorizationCode(code);
    const claims = decodeIdToken(tokens.idToken()) as {
      sub: string;
      email?: string;
    };

    // Apple sends user name only on first sign-in, in the POST body
    let displayName: string | null = null;
    if (userJson) {
      try {
        const appleUser = JSON.parse(userJson) as {
          name?: { firstName?: string; lastName?: string };
        };
        const first = appleUser.name?.firstName ?? '';
        const last = appleUser.name?.lastName ?? '';
        displayName = [first, last].filter(Boolean).join(' ') || null;
      } catch {
        // malformed user JSON — ignore, use email/sub
      }
    }

    const userId = `apple:${claims.sub}`;
    // Never the email local part (#434); see the Google callback. Apple sends
    // the name only on the first sign-in, so a later one keeps what is stored.
    const login = neutralDisplayName();

    await c.env.DB.prepare(
      `INSERT INTO users (id, github_id, github_login, avatar_url, created_at, provider, provider_id, email, display_name, sessions_valid_after)
       VALUES (?, 0, ?, NULL, ?, 'apple', ?, ?, COALESCE(?, ?), ?)
       ON CONFLICT(id) DO UPDATE SET
         email = COALESCE(excluded.email, users.email),
         display_name = COALESCE(?, users.display_name)`,
    )
      .bind(
        userId,
        login,
        Date.now(),
        claims.sub,
        claims.email ?? null,
        displayName,
        login,
        newAccountSessionMark(),
        displayName,
      )
      .run();

    const roles = await computeRoles(userId, login, c.env, 'apple');
    return await finishFlow(c, state, userId, roles, 'None');
  } catch (err) {
    console.error('Apple OAuth callback error:', err);
    return c.text('Apple sign-in failed. Please try again.', 500);
  }
});

/**
 * Magic links always deliver in the fragment (#495); `returnTo` is bound to
 * `appId` (isAllowedReturnTo), the link is single-use and lives 15 minutes.
 *
 * Browser binding (#514): when the request comes from the page the link
 * returns to (its Origin is returnTo's origin), the response sets the same
 * per-flow `__Host-fas_oauth_<nonce>` cookie as the OAuth flows, and the link
 * carries the hash of its secret. Opened in that browser, the link signs in
 * directly. Opened anywhere else (another browser or device, or a link
 * someone else requested and forwarded) it shows a confirmation page naming
 * the account first, so an attacker's own link cannot silently sign a victim
 * into the attacker's account (login CSRF). The Origin check stops a page on
 * another origin from planting the cookie for a link it requested.
 */
authRoutes.post('/auth/email/start', async (c) => {
  if (!c.env.EMAIL) return c.text('Email auth not configured', 503);

  const body = await c.req
    .json<{
      email?: string;
      appId?: string;
      returnTo?: string;
      responseMode?: string;
      clientState?: string;
    } | null>()
    .catch(() => null);
  if (!body) return c.text('invalid JSON body', 400);
  const { email: rawEmail, appId, returnTo, responseMode, clientState } = body;

  if (!rawEmail || !appId || !returnTo) {
    return c.text('missing email, appId, or returnTo', 400);
  }
  if (responseMode !== undefined) {
    return c.text('responseMode is not supported for magic links', 400);
  }
  if (
    clientState !== undefined &&
    !(typeof clientState === 'string' && isClientState(clientState))
  ) {
    return c.text('invalid clientState', 400);
  }
  // Normalize first (trim + lowercase) so UI-side whitespace doesn't reject
  // valid addresses; then validate the canonical form.
  const email = normalizeEmail(rawEmail);
  if (!isLikelyEmail(email)) return c.text('invalid email', 400);
  if (!isAllowedReturnTo(returnTo, appId)) return c.text('returnTo not allowed', 400);

  // Per-recipient send throttle. Silently succeed (don't leak account presence
  // or give an abuse oracle) but skip the actual send if within the cooldown.
  const nowMs = Date.now();
  if (emailSendMap.size > 5000) {
    for (const [k, t] of emailSendMap) {
      if (nowMs - t > EMAIL_SEND_COOLDOWN_MS) emailSendMap.delete(k);
    }
  }
  const lastSend = emailSendMap.get(email) ?? 0;
  if (nowMs - lastSend < EMAIL_SEND_COOLDOWN_MS) {
    return c.json({ ok: true });
  }
  // Keyed by hash, so no address or IP is stored. Silent on refusal, like the
  // cooldown. Checked here, counted only after a successful send (below).
  const usage = d1UsageStore(c.env.DB);
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const day = dayKey(nowMs);
  const emailHash = await sha256Hex(email);
  const ipHash = await sha256Hex(ip);
  const caps = [
    [`magic:${emailHash}:${ipHash}`, MAGIC_LINKS_PER_ADDRESS_PER_IP_PER_DAY],
    [`magic:${emailHash}`, MAGIC_LINKS_PER_ADDRESS_PER_DAY],
    [`magicip:${ipHash}`, MAGIC_LINKS_PER_IP_PER_DAY],
  ] as const;
  for (const [key, limit] of caps) {
    if ((await usage.read(key, day)) >= limit) return c.json({ ok: true });
  }

  let cookie: string | undefined;
  const claims: EmailMagicState = {
    email,
    appId,
    returnTo,
    ...(clientState ? { clientState } : {}),
    exp: Math.floor(Date.now() / 1000) + MAGIC_LINK_TTL_SECONDS,
  };
  // At most MAX_PENDING_LINK_COOKIES pending links bind per browser, so a page
  // looping this endpoint cannot grow the API's Cookie header without bound.
  if (
    c.req.header('origin') === new URL(returnTo).origin &&
    countFlowCookies(c) < MAX_PENDING_LINK_COOKIES
  ) {
    const nonce = randomToken();
    const secret = randomToken();
    claims.nonce = nonce;
    claims.bh = await sha256Hex(secret);
    cookie = flowCookie(c.req.url, nonce, secret, 'Lax', MAGIC_LINK_TTL_SECONDS);
  }
  const token = await signPayload<EmailMagicState>(claims, c.env.SESSION_SIGNING_KEY);

  const callbackUrl = new URL('/v1/auth/email/callback', c.req.url);
  callbackUrl.searchParams.set('token', token);

  // The sign-in destination, displayed in the email body so the recipient
  // can sanity-check where this is taking them before they click.
  const dest = new URL(returnTo).origin;

  try {
    await sendEmail(c.env.EMAIL, {
      to: email,
      subject: `Sign in to ${dest}`,
      replyTo: 'support@freeappstore.online',
      text: `Click the link below to sign in to ${dest}.

${callbackUrl.toString()}

This link expires in 15 minutes. If you didn't request it, ignore this email.`,
      html: `<p>Click the link below to sign in to <strong>${dest}</strong>.</p>
<p><a href="${callbackUrl.toString()}">Sign in</a></p>
<p style="color:#888;font-size:12px">This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
    });
  } catch (err) {
    console.error('Magic-link email send failed', err);
    return c.text('Email delivery temporarily unavailable. Please try again.', 502);
  }
  // Only throttle after Email Service accepted the message. A failed send must
  // be immediately retryable rather than returning a misleading success.
  emailSendMap.set(email, nowMs);
  for (const [key] of caps) await usage.bump(key, day, 1);

  // 200 regardless of whether the email exists — don't leak account presence.
  if (cookie) c.header('Set-Cookie', cookie);
  return c.json({ ok: true });
});

/** Signature, expiry and return_to of a magic link; consumes nothing. */
async function readMagicLink(
  c: Ctx,
  tokenRaw: string,
): Promise<{ ok: true; state: EmailMagicState } | { ok: false; res: Response }> {
  const state = await verifyPayload<EmailMagicState>(tokenRaw, c.env.SESSION_SIGNING_KEY);
  if (!state) return { ok: false, res: c.text('invalid token', 400) };
  if (state.exp < Math.floor(Date.now() / 1000))
    return { ok: false, res: c.text('link expired', 400) };
  if (!isAllowedReturnTo(state.returnTo, state.appId)) {
    return { ok: false, res: c.text('returnTo not allowed', 400) };
  }
  return { ok: true, state };
}

authRoutes.get('/auth/email/callback', async (c) => {
  const tokenRaw = c.req.query('token');
  if (!tokenRaw) return c.text('missing token', 400);
  const link = await readMagicLink(c, tokenRaw);
  if (!link.ok) return link.res;
  const { state } = link;
  const secret = state.nonce ? readFlowCookie(c, state.nonce) : null;
  if (!secret || !state.bh || (await sha256Hex(secret)) !== state.bh) {
    return confirmMagicLinkPage(tokenRaw, state);
  }
  return completeMagicLink(c, tokenRaw, state);
});

/**
 * The confirmation page's button. Only a form on the API's own origin may
 * submit it: a cross-site page cannot auto-post a forwarded link here, and
 * the page itself cannot be framed (frame-ancestors 'none').
 */
authRoutes.post('/auth/email/callback', async (c) => {
  const site = c.req.header('sec-fetch-site');
  const sameOrigin = site
    ? site === 'same-origin'
    : c.req.header('origin') === new URL(c.req.url).origin;
  if (!sameOrigin) return c.text('cross-site sign-in refused', 403);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const tokenRaw = typeof form.token === 'string' ? form.token : '';
  if (!tokenRaw) return c.text('missing token', 400);
  const link = await readMagicLink(c, tokenRaw);
  if (!link.ok) return link.res;
  return completeMagicLink(c, tokenRaw, link.state);
});

/**
 * "Continue signing in as alice@example.com to <app>?" — consumes nothing. The
 * address is shown in full: a masked one (a***@example.com) is easy for an
 * attacker to match with an address of their own, and whoever holds the link
 * can sign in as it anyway.
 */
function confirmMagicLinkPage(tokenRaw: string, state: EmailMagicState): Response {
  const host = new URL(state.returnTo).host;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Continue signing in — FreeAppStore</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  main { max-width: 420px; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 0; background: #2563eb; color: #fff; cursor: pointer; }
  p.small { color: #64748b; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Continue signing in?</h1>
  <p>Continue signing in as <strong>${escapeHtml(state.email)}</strong> to <strong>${escapeHtml(state.appId)}</strong> (${escapeHtml(host)})?</p>
  <form method="post" action="/v1/auth/email/callback">
    <input type="hidden" name="token" value="${escapeHtml(tokenRaw)}">
    <button type="submit">Continue</button>
  </form>
  <p class="small">This link was opened in a different browser from the one that asked for it. If you did not request it, or the address is not yours, close this page: continuing would sign you in to someone else's account.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The URL carries the token. Not no-referrer: that would make a browser
      // without Sec-Fetch-Site send `Origin: null` on the confirm POST.
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

/** Consume the link (single use) and sign in, clearing its flow cookie if it had one. */
async function completeMagicLink(
  c: Ctx,
  tokenRaw: string,
  state: EmailMagicState,
): Promise<Response> {
  // One-time-use: hash the token and reject if already consumed. Prevents
  // replay from server logs, Referer headers, or shared browser history.
  const tokenHash = await sha256Hex(tokenRaw);
  try {
    await c.env.DB.prepare('INSERT INTO consumed_tokens (hash, expires_at) VALUES (?, ?)')
      .bind(tokenHash, state.exp)
      .run();
  } catch {
    // UNIQUE constraint violation = token already used
    return c.text('link already used — request a new sign-in email', 400);
  }

  // The user id, login and display name are shown to apps, room peers and
  // other stores, so none of them may be derived from the address (#434). The
  // account is found by its address (provider_id); a new one gets a random id
  // and a neutral name.
  const lookup = c.env.DB.prepare(
    "SELECT id, github_login FROM users WHERE provider = 'email' AND provider_id = ?",
  ).bind(state.email);
  let existing = await lookup.first<{ id: string; github_login: string }>();
  if (!existing) {
    const userId = newEmailUserId();
    const login = neutralDisplayName();
    try {
      await c.env.DB.prepare(
        `INSERT INTO users (id, github_id, github_login, avatar_url, created_at, provider, provider_id, email, display_name, sessions_valid_after)
         VALUES (?, 0, ?, NULL, ?, 'email', ?, ?, ?, ?)`,
      )
        .bind(userId, login, Date.now(), state.email, state.email, login, newAccountSessionMark())
        .run();
      existing = { id: userId, github_login: login };
    } catch {
      // Two first sign-ins for one address at once: the unique index let only
      // one row in, so the other request uses it.
      existing = await lookup.first<{ id: string; github_login: string }>();
      if (!existing) throw new Error('email sign-in: insert failed and no row found');
    }
  }
  // Migration 0032 retired `email:` ids and prod held none afterwards; a row
  // that still has one would mint a session verifySession rejects. Refuse it.
  if (existing.id.startsWith('email:')) {
    console.error('email_signin_legacy_id', {
      provider: 'email',
      reason: 'row keeps a retired email: id',
    });
    return c.text('account needs migration — contact support', 401);
  }
  const { id: userId, github_login: login } = existing;

  const { roles, appRoles } = await computeRoles(userId, login, c.env, 'email');
  const session = await signSession(userId, c.env.SESSION_SIGNING_KEY, {
    aud: sessionAudience(state.appId),
    roles,
    appRoles,
  });
  // Only these fields: a link always delivers in the fragment, whatever else
  // its (signed, but possibly pre-#495) state carries.
  const delivery = await deliverSession(
    c.env,
    {
      appId: state.appId,
      returnTo: state.returnTo,
      ...(state.clientState ? { clientState: state.clientState } : {}),
    },
    session,
  );
  if (!delivery.ok) return c.text(delivery.error, 400);
  const headers: Record<string, string> = { Location: delivery.url };
  if (state.nonce) headers['Set-Cookie'] = flowCookie(c.req.url, state.nonce, '', 'Lax', 0);
  return new Response(null, { status: 302, headers });
}

/**
 * Trade a one-time code from `response_mode=code` for the session token.
 *
 * Deliberately unauthenticated: the caller has no session yet — that is the
 * whole point of the exchange. The PKCE verifier is the credential, and the
 * code is single-use, so possession of the code alone (from a redirect log,
 * say) gets you nothing.
 */
authRoutes.post('/auth/session/exchange', async (c) => {
  const body = await c.req
    .json<{ code?: string; code_verifier?: string }>()
    .catch(() => ({}) as { code?: string; code_verifier?: string });
  if (!body.code || !body.code_verifier) {
    return c.json({ error: 'missing code or code_verifier' }, 400);
  }
  const session = await exchangeAuthCode(c.env, body.code, body.code_verifier);
  // One message for every failure mode — expired, already-redeemed and
  // wrong-verifier are not distinguished, so the endpoint isn't an oracle.
  if (!session) return c.json({ error: 'invalid, expired, or already-used code' }, 400);
  return c.json({ fas_session: session });
});

authRoutes.get('/auth/me', async (c) => {
  try {
    const user = await requireUser(c);
    // Report roles live, not the token's sign-in snapshot: the admin Worker and
    // the agent gate on these. requireUser already blanks githubLogin for
    // non-GitHub identities, so only real GitHub logins match owners/admins.
    const live = await computeRoles(
      user.id,
      user.githubLogin,
      c.env,
      user.githubLogin ? 'github' : 'none',
    );
    const roles = [
      ...new Set([...user.roles.filter((r) => r !== 'admin' && r !== 'creator'), ...live.roles]),
    ];
    return c.json({ ...user, ...scopeRolesToAudience(user.aud, roles, live.appRoles) });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/**
 * Sign out everywhere (#495): every session of this account issued before now
 * — in every app, on every device — is refused from the next request. A
 * console action: an app's token must not be able to sign the user out of
 * every other app. Apps sign out locally (SDK signOut()) until per-session
 * revocation by `sid` exists.
 */
authRoutes.post('/auth/logout', async (c) => {
  try {
    const user = await requireConsoleUser(c);
    await c.env.DB.prepare('UPDATE users SET sessions_valid_after = ? WHERE id = ?')
      .bind(Math.floor(Date.now() / 1000), user.id)
      .run();
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/**
 * Set the user's date of birth — once, irrevocably. Apps prompt for this when
 * they need an age check; once set, every other app on the platform reads it
 * from `GET /v1/auth/me`. 13+ is the platform floor (apps with stricter age
 * requirements check the returned DOB themselves).
 */
authRoutes.patch('/auth/me/date-of-birth', async (c) => {
  try {
    const user = await requireUser(c);
    if (user.dateOfBirth) {
      return c.json({ error: 'date of birth already set' }, 409);
    }
    const body = (await c.req.json().catch(() => null)) as { dateOfBirth?: unknown } | null;
    const dob = typeof body?.dateOfBirth === 'string' ? body.dateOfBirth : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      return c.json({ error: 'dateOfBirth must be YYYY-MM-DD' }, 400);
    }
    const age = ageFromDob(dob);
    if (age == null) {
      return c.json({ error: 'invalid date' }, 400);
    }
    if (age < 13) {
      return c.json({ error: 'must be at least 13' }, 400);
    }
    if (age > 120) {
      return c.json({ error: 'invalid date' }, 400);
    }
    await c.env.DB.prepare('UPDATE users SET date_of_birth = ? WHERE id = ?')
      .bind(dob, user.id)
      .run();
    return c.json({ ...user, dateOfBirth: dob });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/**
 * Delete the signed-in account and its personal data across the platform:
 * API keys, KV, friendships, app roles, owned documents, logs, push
 * subscriptions and reminder schedules, then the user row itself. Runs as one D1 batch (transactional).
 *
 * First-party sessions only (#495): an app's page must not be able to erase
 * the account. The SDK sends apps to the console's account settings for this.
 * Deleting the row is also what revokes every outstanding session — requireUser
 * refuses a FAS-native uid with no row.
 *
 * Deliberately NOT deleted: apps the user owns (provisioned resources with their
 * own deprovision flow, including their app_secrets, which are keyed by app) and
 * app-shared counters.
 */
authRoutes.delete('/auth/me', async (c) => {
  try {
    const user = await requireConsoleUser(c);
    const db = c.env.DB;
    await db.batch([
      db.prepare('DELETE FROM user_api_keys WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM kv WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM friendships WHERE user_a = ? OR user_b = ?').bind(user.id, user.id),
      db.prepare('DELETE FROM app_roles WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM documents WHERE owner_id = ?').bind(user.id),
      db.prepare('DELETE FROM app_logs WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM push_schedules WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM app_votes WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM idea_builders WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM agent_sessions WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM complimentary_grants WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/**
 * Compute platform roles for a user at sign-in time. Roles are baked
 * into the session token so per-request checks are zero-I/O.
 *
 * - 'user' — always (signed in)
 * - 'creator' — has at least one published app
 * - 'admin' — GitHub login is in ADMIN_GITHUB_LOGINS, or the stable user id
 *   (e.g. `google:<sub>`) is in ADMIN_USER_IDS
 */
export async function computeRoles(
  userId: string,
  login: string,
  env: Env,
  provider = 'github',
): Promise<{ roles: string[]; appRoles: Record<string, string[]> }> {
  const roles = ['user'];
  const appRoles: Record<string, string[]> = {};

  // SECURITY: app ownership (apps.owner_login) and admin (ADMIN_GITHUB_LOGINS)
  // are keyed by GitHub username. For non-GitHub providers `login` is the email
  // local-part (attacker-chosen on any domain they control), so matching it
  // against GitHub usernames would let someone who can receive mail at
  // <adminGithubLogin>@anydomain or <appOwner>@anydomain claim admin / app
  // ownership. Only honor login-based matches for actual GitHub auth; per-app
  // grants below are keyed by user_id and remain valid for every provider.
  const isGithub = provider === 'github';

  try {
    // An app attributed to a login before its owner ever signed in has no
    // owner_id yet (e.g. an admin publishing for a contributor): the first
    // GitHub sign-in as that login binds it to the immutable id (#566). Rows
    // that already carry an id are never touched.
    if (isGithub) {
      await env.DB.prepare(
        `UPDATE apps SET owner_id = ?
         WHERE owner_id IS NULL AND owner_login = ? COLLATE NOCASE
           AND (store IS NULL OR store = 'apps')`,
      )
        .bind(userId, login)
        .run();
    }
    // One D1 round trip: per-app role assignments (keyed by user_id — safe for
    // all providers) plus, for GitHub users, the apps they created. The owned
    // list doubles as the 'creator' check (#442).
    const stmts = [
      env.DB.prepare('SELECT app_id, role_name FROM app_roles WHERE user_id = ?').bind(userId),
    ];
    if (isGithub) {
      stmts.push(env.DB.prepare('SELECT id FROM apps WHERE owner_id = ?').bind(userId));
    }
    const [assigned, owned] = (await env.DB.batch(stmts)) as [
      D1Result<{ app_id: string; role_name: string }>,
      D1Result<{ id: string }> | undefined,
    ];
    const ownedApps = owned?.results ?? [];
    if (ownedApps.length > 0) roles.push('creator');

    for (const r of assigned.results ?? []) {
      (appRoles[r.app_id] ??= []).push(r.role_name);
    }
    // Auto-assign 'owner' for apps this user created (not stored in DB).
    for (const a of ownedApps) {
      (appRoles[a.id] ??= []).push('owner');
    }
  } catch {
    // Tables don't exist yet (fresh DB or test env) — skip
  }

  // Admin: login matches only for GitHub (see security note above); the user id
  // is provider-issued, so ADMIN_USER_IDS works for every provider (#22).
  if ((isGithub && isAdminLogin(login, env)) || isAdminUserId(userId, env)) roles.push('admin');

  return { roles, appRoles };
}

/** `em:` + 128 random bits as hex. Unrelated to the address it signs in with. */
function newEmailUserId(): string {
  return `em:${randomHex(16)}`;
}

/**
 * Default login / display name for a non-GitHub account: `user-` + 4 hex
 * chars (#434). Migration 0032 gives existing accounts the same shape.
 */
function neutralDisplayName(): string {
  return `user-${randomHex(2)}`;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function ageFromDob(dob: string): number | null {
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
