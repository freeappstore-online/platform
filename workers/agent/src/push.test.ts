import { beforeAll, describe, expect, it, vi } from "vitest";
import { type PushSubscription, sendWebPush } from "./push";

// The sender itself is tested where it lives, packages/backend/src/lib/web-push.test.ts
// (#146). These check the agent's import resolves to it and behaves the same.
let VAPID_PUBLIC: string;
let VAPID_PRIVATE: string;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  VAPID_PUBLIC = b64url(pubRaw);
  VAPID_PRIVATE = privJwk.d!;
});

const FAKE_SUB: PushSubscription = { endpoint: "https://fcm.googleapis.com/fcm/send/test-id-123" };

describe("agent sendWebPush (shared with the backend)", () => {
  it("POSTs a VAPID-signed, no-payload push and reports the status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 201 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      expect(await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE)).toEqual({ ok: true, status: 201 });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(FAKE_SUB.endpoint);
      expect(opts.method).toBe("POST");
      expect(opts.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
      expect(opts.headers.TTL).toBe("86400");
      expect(opts.body).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports an expired subscription (410) as not ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 410 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      expect(await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE)).toEqual({ ok: false, status: 410 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
