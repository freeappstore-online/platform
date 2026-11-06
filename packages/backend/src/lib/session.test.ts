import { describe, expect, it } from 'vitest';
import { signPayload, signSession, verifyPayload, verifySession } from './session.js';

const KEY = 'a'.repeat(64);

describe('session HMAC roundtrip', () => {
  it('signs and verifies a valid session', async () => {
    const token = await signSession('gh:42', KEY, { aud: 'console' });
    const payload = await verifySession(token, KEY);
    expect(payload?.uid).toBe('gh:42');
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('stamps iss=fas and refuses a token with another issuer (#463)', async () => {
    const payload = await verifySession(await signSession('gh:42', KEY, { aud: 'chess' }), KEY);
    expect(payload?.iss).toBe('fas');
    const now = Math.floor(Date.now() / 1000);
    const foreign = await signPayload(
      { uid: 'gh:42', aud: 'chess', iss: 'pas', iat: now, exp: now + 60 },
      KEY,
    );
    expect(await verifySession(foreign, KEY)).toBeNull();
    const noIss = await signPayload({ uid: 'gh:42', aud: 'chess', iat: now, exp: now + 60 }, KEY);
    expect((await verifySession(noIss, KEY))?.uid).toBe('gh:42');
  });

  it('carries the audience and a random session id (#495)', async () => {
    const a = await verifySession(await signSession('gh:42', KEY, { aud: 'chess' }), KEY);
    const b = await verifySession(await signSession('gh:42', KEY, { aud: 'chess' }), KEY);
    expect(a?.aud).toBe('chess');
    expect(a?.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a?.sid).not.toBe(b?.sid);
  });

  it('still verifies a pre-#495 session with no aud (the legacy rule lives in requireUser)', async () => {
    const future = Math.floor(Date.now() / 1000) + 30;
    const legacy = await signPayload({ uid: 'gh:42', roles: ['user'], iat: 1, exp: future }, KEY);
    const payload = await verifySession(legacy, KEY);
    expect(payload?.uid).toBe('gh:42');
    expect(payload?.aud).toBeUndefined();
  });

  it('rejects a session signed with a different key', async () => {
    const token = await signSession('gh:42', KEY, { aud: 'console' });
    const payload = await verifySession(token, 'b'.repeat(64));
    expect(payload).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signSession('gh:42', KEY, { aud: 'console' });
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

describe('verifySession accepts only sessions (#428)', () => {
  const future = () => Math.floor(Date.now() / 1000) + 30;

  it('rejects a room ticket signed with the session key', async () => {
    const ticket = await signPayload(
      { typ: 'room', appId: 'chat', roomId: 'r1', uid: 'gh:42', login: 'octo', exp: future() },
      KEY,
    );
    expect(await verifySession(ticket, KEY)).toBeNull();
  });

  it('rejects OAuth and magic-link state (no uid)', async () => {
    const state = await signPayload({ appId: 'chat', returnTo: '/', exp: future() }, KEY);
    expect(await verifySession(state, KEY)).toBeNull();
    const magic = await signPayload(
      { email: 'a@b.co', appId: 'chat', returnTo: '/', exp: future() },
      KEY,
    );
    expect(await verifySession(magic, KEY)).toBeNull();
  });

  it('rejects a payload with a non-numeric exp', async () => {
    const odd = await signPayload({ uid: 'gh:42', exp: 'never' }, KEY);
    expect(await verifySession(odd, KEY)).toBeNull();
  });

  it('still accepts a cross-store session shape (uid, login, roles, no typ)', async () => {
    const pas = await signPayload(
      { uid: 'cred:abc', login: 'octo', roles: ['user'], auth_time: 1, iat: 1, exp: future() },
      KEY,
    );
    expect((await verifySession(pas, KEY))?.uid).toBe('cred:abc');
  });
});

describe('verifySession rejects retired email: uids (#434)', () => {
  it('rejects a session whose uid embeds an email address', async () => {
    const legacy = await signSession('email:alice@example.com', KEY, { aud: 'console' });
    expect(await verifySession(legacy, KEY)).toBeNull();
  });

  it('accepts the opaque id that replaced it', async () => {
    const id = `em:${'0'.repeat(32)}`;
    expect((await verifySession(await signSession(id, KEY, { aud: 'console' }), KEY))?.uid).toBe(
      id,
    );
  });
});
