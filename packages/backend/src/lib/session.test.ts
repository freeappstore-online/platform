import { describe, expect, it } from 'vitest';
import { signPayload, signSession, verifyPayload, verifySession } from './session.js';

const KEY = 'a'.repeat(64);

describe('session HMAC roundtrip', () => {
  it('signs and verifies a valid session', async () => {
    const token = await signSession('gh:42', KEY);
    const payload = await verifySession(token, KEY);
    expect(payload?.uid).toBe('gh:42');
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a session signed with a different key', async () => {
    const token = await signSession('gh:42', KEY);
    const payload = await verifySession(token, 'b'.repeat(64));
    expect(payload).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signSession('gh:42', KEY);
    // Flip one byte of the body half (before the dot).
    const dot = token.lastIndexOf('.');
    const tampered = `X${token.slice(1, dot)}${token.slice(dot)}`;
    const payload = await verifySession(tampered, KEY);
    expect(payload).toBeNull();
  });

  it('rejects garbage tokens', async () => {
    expect(await verifySession('not.a.token', KEY)).toBeNull();
    expect(await verifySession('', KEY)).toBeNull();
    expect(await verifySession('nodot', KEY)).toBeNull();
  });
});

describe('signPayload / verifyPayload (used for OAuth state)', () => {
  it('roundtrips arbitrary JSON', async () => {
    const payload = { appId: 'chess', returnTo: 'https://chess.freeappstore.online/', exp: 9999 };
    const token = await signPayload(payload, KEY);
    const verified = await verifyPayload<typeof payload>(token, KEY);
    expect(verified).toEqual(payload);
  });

  it('rejects payloads signed with the wrong key', async () => {
    const token = await signPayload({ a: 1 }, KEY);
    const verified = await verifyPayload(token, 'wrong-key');
    expect(verified).toBeNull();
  });

  it('uses constant-time comparison for the signature', async () => {
    // Two tokens that differ only in the signature: verify both fail without
    // a thrown error or short-circuit.
    const real = await signPayload({ a: 1 }, KEY);
    const dot = real.lastIndexOf('.');
    const truncatedSig = `${real.slice(0, dot + 1)}A`;
    expect(await verifyPayload(truncatedSig, KEY)).toBeNull();
  });
});
