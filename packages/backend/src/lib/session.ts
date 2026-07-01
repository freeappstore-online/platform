import type { SessionPayload } from '../types.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function signSession(
  uid: string,
  signingKey: string,
  opts?: { roles?: string[]; appRoles?: Record<string, string[]> },
): Promise<string> {
  const payload: SessionPayload = {
    uid,
    roles: opts?.roles ?? ['user'],
    appRoles: opts?.appRoles ?? {},
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
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
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

async function hmac(data: string, keyMaterial: string): Promise<string> {
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

function b64urlBytes(bytes: Uint8Array): string {
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
