// FAS session token verification — vendored from fas/platform/packages/backend/src/lib/session.ts.
// Tokens are HMAC-SHA256 signed: base64url(payload) + "." + base64url(hmac).

import { timingSafeEqual } from "./pkce.js";

export interface SessionPayload {
  uid: string;
  roles?: string[];
  appRoles?: Record<string, string[]>;
  /** Audience (#495): `console` for first-party sessions, else the app id; absent before #495. */
  aud?: string;
  sid?: string;
  iat: number;
  exp: number;
}

/** The audience this worker needs: it calls console-only routes (/v1/publish, /v1/apps/mine). */
export const CONSOLE_AUD = "console";

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
  if (claims.typ !== undefined || typeof claims.uid !== "string") return null;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
  // `email:<address>` uids were retired by the backend's migration 0032 (#434).
  if (claims.uid.startsWith("email:")) return null;
  return payload;
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

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return atob(padded);
}
