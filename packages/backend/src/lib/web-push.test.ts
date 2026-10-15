import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type PushSubscription,
  pushAudience,
  sendWebPush,
  vapidAuthorization,
} from './web-push.js';

// Moved from workers/agent/src/push.test.ts with the module (#146); the agent
// now imports this file. A test VAPID key pair is generated at runtime; never
// commit real keys.
let VAPID_PUBLIC: string;
let VAPID_PRIVATE: string;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
const b64urlBytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer,
  );
  const privJwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  VAPID_PUBLIC = b64url(pubRaw);
  VAPID_PRIVATE = privJwk.d as string;
});

const FAKE_SUB: PushSubscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-id-123' };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function mockFetch(impl: () => Promise<unknown>) {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
type Init = RequestInit & { headers: Record<string, string> };
const callArgs = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls[0] as unknown as [string, Init];
const decodePart = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
const jwtOf = (auth: string) => auth.match(/t=([^,]+)/)?.[1] ?? '';

describe('sendWebPush (no payload)', () => {
  it('POSTs to the subscription endpoint and reports { ok, status }', async () => {
    const fetchMock = mockFetch(async () => ({ status: 201 }));
    expect(await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE)).toEqual({
      ok: true,
      status: 201,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe(FAKE_SUB.endpoint);
    expect(init.method).toBe('POST');
  });

  it('sends a VAPID Authorization header with an ES256 JWT for the endpoint origin', async () => {
    const fetchMock = mockFetch(async () => ({ status: 201 }));
    await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE);
    const auth = callArgs(fetchMock)[1].headers.Authorization as string;
    expect(auth).toMatch(/^vapid t=.+, k=.+$/);
    expect(auth).toContain(VAPID_PUBLIC);
    const parts = jwtOf(auth).split('.');
    expect(parts).toHaveLength(3);
    expect(decodePart(parts[0] as string)).toEqual({ typ: 'JWT', alg: 'ES256' });
    const payload = decodePart(parts[1] as string);
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(payload.sub).toBe('mailto:noreply@freeappstore.online');
    const now = Math.floor(Date.now() / 1000);
    expect(payload.exp).toBeGreaterThan(now);
    expect(payload.exp).toBeLessThanOrEqual(now + 24 * 60 * 60); // RFC 8292 cap
  });

  it('signs a JWT that the public key verifies', async () => {
    const auth = await vapidAuthorization(
      'https://fcm.googleapis.com',
      VAPID_PUBLIC,
      VAPID_PRIVATE,
    );
    const [h, p, sig] = jwtOf(auth).split('.') as [string, string, string];
    const key = await crypto.subtle.importKey(
      'raw',
      b64urlBytes(VAPID_PUBLIC),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(valid).toBe(true);
  });

  it('sets TTL and Content-Length and sends no body', async () => {
    const fetchMock = mockFetch(async () => ({ status: 201 }));
    await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE);
    const init = callArgs(fetchMock)[1];
    expect(init.headers.TTL).toBe('86400');
    expect(init.headers['Content-Length']).toBe('0');
    expect(init.body).toBeUndefined();
  });

  it.each([
    [410, false],
    [404, false],
    [429, false],
    [500, false],
    [200, true],
    [202, true],
  ])('reports status %i as ok=%s', async (status, ok) => {
    mockFetch(async () => ({ status }));
    expect(await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE)).toEqual({ ok, status });
  });

  it('reports a network error as status 0 instead of throwing', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE)).toEqual({
      ok: false,
      status: 0,
    });
  });

  it('uses a precomputed Authorization header when given one', async () => {
    const fetchMock = mockFetch(async () => ({ status: 201 }));
    await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE, 'vapid t=precomputed, k=key');
    expect(callArgs(fetchMock)[1].headers.Authorization).toBe('vapid t=precomputed, k=key');
  });

  it('uses the endpoint origin as the audience', async () => {
    const moz = 'https://updates.push.services.mozilla.com/push/v1/test-123';
    expect(pushAudience(moz)).toBe('https://updates.push.services.mozilla.com');
    const fetchMock = mockFetch(async () => ({ status: 201 }));
    await sendWebPush({ endpoint: moz }, VAPID_PUBLIC, VAPID_PRIVATE);
    const jwt = jwtOf(callArgs(fetchMock)[1].headers.Authorization as string);
    expect(decodePart(jwt.split('.')[1] as string).aud).toBe(
      'https://updates.push.services.mozilla.com',
    );
  });
});
