import type { SessionPayload } from '../types.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** The audience of every first-party session (storefront, console, admin, MCP, CLI). */
export const CONSOLE_AUD = 'console';
/**
 * The audience `requireUser` assigns to a session minted before #495 (no
 * `aud`). Deliberately outside APP_ID_RE, so no app id can ever equal it.
 */
export const LEGACY_AUD = '#legacy';
/** A cross-store token that claims `console`: matches no app and is not first-party. */
export const CROSS_STORE_AUD = '#cross-store';

/** The `iss` of every session this backend mints. */
export const SESSION_ISSUER = 'fas';

export async function signSession(
  uid: string,
  signingKey: string,
  opts: { aud: string; roles?: string[]; appRoles?: Record<string, string[]> },
): Promise<string> {
  const sid = new Uint8Array(16);
  crypto.getRandomValues(sid);
  const payload: SessionPayload = {
    uid,
    roles: opts.roles ?? ['user'],
    appRoles: opts.appRoles ?? {},
    aud: opts.aud,
    iss: SESSION_ISSUER,
    sid: b64urlBytes(sid),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmac(body, signingKey);
  return `${body}.${sig}`;
}

export async function verifySession(
  token: string,
  signingKey: string,
): Promise<SessionPayload | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(body, signingKey);
  if (!timingSafeEqual(sig, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(body)) as SessionPayload;
  } catch {
    return null;
  }
  // Room tickets and OAuth/magic-link state share this key and format. Only a
  // session has a string uid, a numeric exp and no typ (PAS sessions too), so
  // a ticket or state blob is never accepted as a session (#428).
  const claims = payload as SessionPayload & { typ?: unknown };
  if (claims.typ !== undefined || typeof claims.uid !== 'string') return null;
  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
  // `email:<address>` uids were retired by migration 0032 (#434): a session
  // minted before it must sign in again rather than keep handing the address
  // to apps and room peers.
  if (claims.uid.startsWith('email:')) return null;
  // A token another issuer stamped with its own `iss` is never a FAS session.
  if (payload.iss !== undefined && payload.iss !== SESSION_ISSUER) return null;
  return payload;
}

/**
 * Sign an opaque payload with the same HMAC key. Used for OAuth state so we
 * can detect tampering when GitHub redirects back with the state we set.
 */
export async function signPayload<T>(payload: T, signingKey: string): Promise<string> {
  const body = b64url(JSON.stringify(payload));
  const sig = await hmac(body, signingKey);
  return `${body}.${sig}`;
}

export async function verifyPayload<T>(token: string, signingKey: string): Promise<T | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(body, signingKey);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(b64urlDecode(body)) as T;
  } catch {
    return null;
  }
}

export async function hmac(data: string, keyMaterial: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlBytes(new Uint8Array(sig));
}

function b64url(s: string): string {
  return b64urlBytes(new TextEncoder().encode(s));
}

export function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return atob(padded);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
