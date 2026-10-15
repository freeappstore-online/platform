/**
 * Web Push: send no-payload push notifications signed with VAPID (RFC 8292).
 *
 * Shared by the backend's scheduled delivery (`lib/push-delivery.ts`, #146)
 * and the agent worker, which imports this file directly
 * (workers/agent/src/push.ts). It has no imports so both projects compile it
 * as-is; keep it that way.
 *
 * No payload: the app's service worker shows its own text when the push
 * event arrives, so nothing about the user travels through the push service.
 */

export interface PushSubscription {
  endpoint: string;
  keys?: { p256dh: string; auth: string };
}

/**
 * `status` is the push service's HTTP status, or 0 when the request never got
 * a response (DNS, TLS, network). Callers use it to tell an expired
 * subscription (404/410) from a transient failure (429, 5xx, 0).
 */
export interface WebPushResult {
  ok: boolean;
  status: number;
}

/** How long a push service should keep an undelivered message (seconds). */
const TTL_SECONDS = 86400;
/** VAPID JWT lifetime. RFC 8292 caps it at 24h; stay well inside. */
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

export async function sendWebPush(
  subscription: PushSubscription,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  authorization?: string,
): Promise<WebPushResult> {
  const auth =
    authorization ??
    (await vapidAuthorization(
      pushAudience(subscription.endpoint),
      vapidPublicKey,
      vapidPrivateKey,
    ));
  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: auth,
        TTL: String(TTL_SECONDS),
        'Content-Length': '0',
      },
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** The JWT audience for an endpoint: its origin (one JWT covers a whole push service). */
export function pushAudience(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/**
 * The `Authorization: vapid t=<jwt>, k=<public key>` header for one push
 * service. Signing is the expensive part, so a sender that pushes to many
 * devices on the same service can compute this once and pass it to
 * sendWebPush.
 */
export async function vapidAuthorization(
  audience: string,
  publicKey: string,
  privateKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = b64urlString(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const jwtPayload = b64urlString(
    JSON.stringify({
      aud: audience,
      exp: now + JWT_LIFETIME_SECONDS,
      sub: 'mailto:noreply@freeappstore.online',
    }),
  );
  const unsigned = `${jwtHeader}.${jwtPayload}`;

  const pubBytes = b64urlDecode(publicKey);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    d: privateKey,
  };
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `vapid t=${unsigned}.${b64urlEncode(new Uint8Array(sig))}, k=${publicKey}`;
}

// ── Base64url helpers ──

function b64urlString(str: string): string {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlDecode(str: string): Uint8Array {
  return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
