/**
 * The vendored FAS session verifier accepts only a session: a string uid that
 * is not a retired `email:<address>` id (#434), a numeric exp, and no `typ`
 * (room tickets and OAuth state share the key and format, #428).
 */
import { describe, expect, it } from "vitest";
import { verifySession } from "./session.js";

const KEY = "test-signing-key";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: Record<string, unknown>, key = KEY): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

const future = () => Math.floor(Date.now() / 1000) + 60;

describe("verifySession (vendored)", () => {
  it("accepts a FAS session and a cross-store session", async () => {
    expect((await verifySession(await sign({ uid: "gh:42", iat: 1, exp: future() }), KEY))?.uid).toBe(
      "gh:42",
    );
    expect(
      (await verifySession(await sign({ uid: "cred:abc", login: "octo", roles: ["user"], exp: future() }), KEY))
        ?.uid,
    ).toBe("cred:abc");
  });

  it("rejects a retired email: uid (#434)", async () => {
    const legacy = await sign({ uid: "email:alice@example.com", iat: 1, exp: future() });
    expect(await verifySession(legacy, KEY)).toBeNull();
  });

  it("rejects a room ticket, state without a uid, and a non-numeric exp (#428)", async () => {
    const ticket = await sign({ typ: "room", appId: "a", roomId: "r", uid: "gh:42", login: "o", exp: future() });
    expect(await verifySession(ticket, KEY)).toBeNull();
    expect(await verifySession(await sign({ appId: "a", returnTo: "/", exp: future() }), KEY)).toBeNull();
    expect(await verifySession(await sign({ uid: "gh:42", exp: "never" }), KEY)).toBeNull();
  });

  it("rejects a wrong key, an expired session and garbage", async () => {
    expect(await verifySession(await sign({ uid: "gh:42", exp: future() }, "other"), KEY)).toBeNull();
    expect(await verifySession(await sign({ uid: "gh:42", exp: 1 }), KEY)).toBeNull();
    expect(await verifySession("nope", KEY)).toBeNull();
  });
});
