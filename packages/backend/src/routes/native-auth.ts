/**
 * Native companion pairing (#616). The phone starts a pairing with a hashed
 * verifier, the user signs in on these API-origin pages and approves, and the
 * phone redeems the approval with its verifier for an `ndev_` device token.
 *
 * Sign-in reuses the FAS code-mode flow (`response_mode=code` + PKCE) with the
 * first-party return id `native` (lib/origins.ts). The PKCE verifier is derived
 * from the HttpOnly pairing cookie, so it never appears in a URL. The session
 * that sign-in mints is only verified here, never stored or returned.
 */
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HttpError } from '../lib/auth.js';
import { exchangeAuthCode, s256Challenge } from '../lib/deliver-session.js';
import { escapeHtml } from '../lib/email.js';
import { isHex64, nativeBody, nativeHash, nativeRandom } from '../lib/native-companion.js';
import { d1UsageStore, dayKey } from '../lib/proxy-rate-limit.js';
import { verifySession } from '../lib/session.js';
import type { Env } from '../types.js';

export const nativeAuthRoutes = new Hono<{ Bindings: Env }>();

const PREFIX = '/v1/native/auth';
const COOKIE = '__Host-fas_native_pairing';
const PAIRING_MS = 10 * 60_000;
const DEVICE_MS = 90 * 24 * 60 * 60_000;
const PAIRINGS_PER_IP_PER_DAY = 30;

type Ctx = Context<{ Bindings: Env }>;
interface Pairing {
  id: string;
  challenge: string;
  label: string;
  user_id: string | null;
  browser_hash: string | null;
  approved: number;
  expires_at: number;
}

const origin = (c: Ctx) => new URL(c.req.url).origin;
const row = (c: Ctx, id: string) =>
  c.env.DB.prepare('SELECT * FROM native_pairings WHERE id = ? AND expires_at > ?')
    .bind(id, Date.now())
    .first<Pairing>();
const pkceVerifier = (nonce: string) => nativeHash(`pkce:${nonce}`);
const phoneCode = (id: string) => id.slice(0, 8).toUpperCase();

function page(c: Ctx, body: string) {
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  return c.html(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect FreeAppStore</title><style>body{font:17px system-ui;max-width:440px;margin:48px auto;padding:24px;color:#0f172a;background:#f8fafc}@media(prefers-color-scheme:dark){body{color:#e2e8f0;background:#0f172a}}a,button{display:block;margin:16px 0;padding:16px;border-radius:12px;background:#2563eb;color:#fff;text-align:center;border:0;font:inherit;text-decoration:none}small{display:block;overflow-wrap:anywhere}</style><main>${body}</main></html>`,
  );
}

nativeAuthRoutes.use('/native/auth/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // same-origin, not no-referrer: under no-referrer browsers send `Origin: null`
  // on the approve form POST, which the Origin check must reject (PAS #617).
  c.header('Referrer-Policy', 'same-origin');
  await next();
});

nativeAuthRoutes.post('/native/auth/start', async (c) => {
  const ipHash = await nativeHash(c.req.header('cf-connecting-ip') ?? 'unknown');
  const allowed = await d1UsageStore(c.env.DB).bumpIfBelow!(
    `nativepair:${ipHash}`,
    dayKey(Date.now()),
    1,
    PAIRINGS_PER_IP_PER_DAY,
  );
  if (!allowed) throw new HttpError(429, 'Try connecting again later.');
  const body = await nativeBody(c);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!isHex64(body.challenge) || !label || label.length > 80) {
    throw new HttpError(400, 'Invalid device connection.');
  }
  const id = nativeRandom();
  await c.env.DB.prepare(
    'INSERT INTO native_pairings (id, challenge, label, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(id, body.challenge, label, Date.now() + PAIRING_MS)
    .run();
  return c.json({
    id,
    authorizationUrl: `${origin(c)}${PREFIX}/authorize?id=${id}`,
    expiresIn: PAIRING_MS / 1000,
  });
});

nativeAuthRoutes.get('/native/auth/authorize', async (c) => {
  const id = c.req.query('id') ?? '';
  const pairing = isHex64(id) ? await row(c, id) : null;
  if (!pairing || pairing.approved || pairing.user_id) {
    throw new HttpError(
      400,
      'Connection expired. Start again from the FreeAppStore app on your phone.',
    );
  }
  const nonce = nativeRandom();
  await c.env.DB.prepare(
    'UPDATE native_pairings SET browser_hash = ? WHERE id = ? AND approved = 0 AND user_id IS NULL',
  )
    .bind(await nativeHash(nonce), id)
    .run();
  setCookie(c, COOKIE, `${id}.${nonce}`, {
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: PAIRING_MS / 1000,
  });
  const challenge = await s256Challenge(await pkceVerifier(nonce));
  const login = (provider: string) => {
    const url = new URL(`/v1/auth/${provider}/start`, origin(c));
    url.searchParams.set('app_id', 'native');
    url.searchParams.set('return_to', `${origin(c)}${PREFIX}/callback`);
    url.searchParams.set('response_mode', 'code');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  };
  return page(
    c,
    `<h1>Connect your phone</h1><p>Sign in with the account you use in your FreeAppStore apps.</p><p>Device: ${escapeHtml(pairing.label)}</p><small>Check this code matches your phone: ${phoneCode(id)}</small><a href="${escapeHtml(login('github'))}">Continue with GitHub</a><a href="${escapeHtml(login('google'))}">Continue with Google</a><p>This connects your account. Location sharing stays off until you turn on an app on your phone.</p>`,
  );
});

async function browserPairing(c: Ctx): Promise<{ pairing: Pairing; nonce: string }> {
  const [id, nonce] = (getCookie(c, COOKIE) ?? '').split('.');
  if (!isHex64(id) || !isHex64(nonce)) {
    throw new HttpError(403, 'Start this connection from the FreeAppStore app on your phone.');
  }
  const pairing = await row(c, id);
  if (!pairing || pairing.approved || pairing.browser_hash !== (await nativeHash(nonce))) {
    throw new HttpError(403, 'Connection expired. Start again.');
  }
  return { pairing, nonce };
}

nativeAuthRoutes.get('/native/auth/callback', async (c) => {
  const { pairing, nonce } = await browserPairing(c);
  const code = c.req.query('code') ?? '';
  const session = code ? await exchangeAuthCode(c.env, code, await pkceVerifier(nonce)) : null;
  const claims = session ? await verifySession(session, c.env.SESSION_SIGNING_KEY) : null;
  const user = claims
    ? await c.env.DB.prepare('SELECT id, github_login, display_name FROM users WHERE id = ?')
        .bind(claims.uid)
        .first<{ id: string; github_login: string; display_name: string | null }>()
    : null;
  if (!user) {
    throw new HttpError(
      401,
      'Sign-in did not finish. Start again from the FreeAppStore app on your phone.',
    );
  }
  const result = await c.env.DB.prepare(
    'UPDATE native_pairings SET user_id = ? WHERE id = ? AND user_id IS NULL AND approved = 0 AND expires_at > ?',
  )
    .bind(user.id, pairing.id, Date.now())
    .run();
  if (!result.meta.changes) throw new HttpError(409, 'Connection already used.');
  return page(
    c,
    `<h1>Connect ${escapeHtml(pairing.label)}?</h1><p>Account: ${escapeHtml(user.display_name || user.github_login)}</p><small>Phone code: ${phoneCode(pairing.id)}</small><p>Only continue if you started this on your phone. No app receives your location yet.</p><form method="post" action="${PREFIX}/approve"><input type="hidden" name="nonce" value="${nonce}"><button>Connect this phone</button></form>`,
  );
});

nativeAuthRoutes.post('/native/auth/approve', async (c) => {
  if (c.req.header('Origin') !== origin(c)) throw new HttpError(403, 'Invalid approval origin.');
  const { pairing, nonce } = await browserPairing(c);
  const form = await c.req.parseBody();
  if (form.nonce !== nonce || !pairing.user_id) {
    throw new HttpError(403, 'Invalid connection approval.');
  }
  await c.env.DB.prepare(
    'UPDATE native_pairings SET approved = 1 WHERE id = ? AND user_id IS NOT NULL AND expires_at > ?',
  )
    .bind(pairing.id, Date.now())
    .run();
  deleteCookie(c, COOKIE, { secure: true, path: '/' });
  return page(
    c,
    '<h1>Phone connected</h1><p>Return to FreeAppStore to choose which apps may receive your location.</p><a href="freeappstore://native/connected">Return to FreeAppStore</a>',
  );
});

nativeAuthRoutes.post('/native/auth/complete', async (c) => {
  const body = await nativeBody(c);
  if (!isHex64(body.id) || !isHex64(body.verifier)) {
    throw new HttpError(400, 'Invalid connection proof.');
  }
  const challenge = await nativeHash(body.verifier);
  const pairing = await row(c, body.id);
  if (!pairing || pairing.challenge !== challenge) {
    throw new HttpError(403, 'Invalid or expired connection.');
  }
  if (!pairing.approved || !pairing.user_id) return c.json({ pending: true }, 202);
  // Only the initiating installation knows the verifier. Consume atomically before issuing.
  const consumed = await c.env.DB.prepare(
    'DELETE FROM native_pairings WHERE id = ? AND challenge = ? AND approved = 1 AND expires_at > ? RETURNING user_id, label',
  )
    .bind(body.id, challenge, Date.now())
    .first<{ user_id: string; label: string }>();
  if (!consumed) throw new HttpError(409, 'Connection already used. Start again.');
  const id = nativeRandom();
  const token = `ndev_${nativeRandom()}`;
  const now = Date.now();
  // No foreign key to users: an account deleted since sign-in gets no device.
  const inserted = await c.env.DB.prepare(
    `INSERT INTO native_devices (id, user_id, label, token_hash, created_at, expires_at)
     SELECT ?, id, ?, ?, ?, ? FROM users WHERE id = ?`,
  )
    .bind(id, consumed.label, await nativeHash(token), now, now + DEVICE_MS, consumed.user_id)
    .run();
  if (!inserted.meta.changes) throw new HttpError(401, 'Account no longer exists.');
  return c.json({ token, deviceId: id });
});
