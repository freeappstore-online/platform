import { describe, expect, it } from 'vitest';
import { isAdminLogin } from './auth.js';
import { signSession, verifySession } from './session.js';

const KEY = 'a'.repeat(64);

describe('session token roles', () => {
  it('includes roles in the token payload', async () => {
    const token = await signSession('gh:42', KEY, { roles: ['user', 'creator'] });
    const payload = await verifySession(token, KEY);
    expect(payload?.roles).toEqual(['user', 'creator']);
  });

  it('includes appRoles in the token payload', async () => {
    const appRoles = { meetup: ['moderator'], studio: ['owner', 'editor'] };
    const token = await signSession('gh:42', KEY, { roles: ['user'], appRoles });
    const payload = await verifySession(token, KEY);
    expect(payload?.appRoles).toEqual(appRoles);
  });

  it('defaults roles to ["user"] when no opts provided', async () => {
    const token = await signSession('gh:42', KEY);
    const payload = await verifySession(token, KEY);
    expect(payload?.roles).toEqual(['user']);
  });

  it('defaults appRoles to {} when no opts provided', async () => {
    const token = await signSession('gh:42', KEY);
    const payload = await verifySession(token, KEY);
    expect(payload?.appRoles).toEqual({});
  });

  it('preserves all roles through sign/verify roundtrip', async () => {
    const roles = ['user', 'creator', 'admin'];
    const token = await signSession('gh:42', KEY, { roles });
    const payload = await verifySession(token, KEY);
    expect(payload?.uid).toBe('gh:42');
    expect(payload?.roles).toEqual(roles);
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('roles cannot be tampered with (HMAC protects entire payload)', async () => {
    const token = await signSession('gh:42', KEY, { roles: ['user'] });
    // Decode payload, change roles, re-encode (without re-signing)
    const dot = token.lastIndexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const decoded = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    decoded.roles = ['user', 'admin']; // escalation attempt
    const tampered = btoa(JSON.stringify(decoded))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = await verifySession(`${tampered}.${sig}`, KEY);
    expect(result).toBeNull(); // signature mismatch
  });

  it('old tokens without roles field still verify (backward compat)', async () => {
    // Simulate an old-format token: just uid/iat/exp, no roles
    const oldPayload = {
      uid: 'gh:42',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    };
    const body = btoa(JSON.stringify(oldPayload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    // Sign it properly
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    let bin = '';
    for (const b of new Uint8Array(sigBuf)) bin += String.fromCharCode(b);
    const sig = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const payload = await verifySession(`${body}.${sig}`, KEY);
    expect(payload).not.toBeNull();
    expect(payload?.uid).toBe('gh:42');
    expect(payload?.roles).toBeUndefined(); // old token, no roles field
  });
});

describe('isAdminLogin', () => {
  const makeEnv = (logins?: string) => ({ ADMIN_GITHUB_LOGINS: logins }) as any;

  it('returns true for a login in the admin list', () => {
    expect(isAdminLogin('serge-ivo', makeEnv('serge-ivo'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAdminLogin('Serge-Ivo', makeEnv('serge-ivo'))).toBe(true);
    expect(isAdminLogin('serge-ivo', makeEnv('SERGE-IVO'))).toBe(true);
  });

  it('handles comma-separated list', () => {
    expect(isAdminLogin('alice', makeEnv('serge-ivo, alice, bob'))).toBe(true);
    expect(isAdminLogin('charlie', makeEnv('serge-ivo, alice, bob'))).toBe(false);
  });

  it('returns false when env var is unset', () => {
    expect(isAdminLogin('serge-ivo', makeEnv(undefined))).toBe(false);
    expect(isAdminLogin('serge-ivo', makeEnv(''))).toBe(false);
  });

  it('handles whitespace in the list', () => {
    expect(isAdminLogin('alice', makeEnv('  alice  ,  bob  '))).toBe(true);
  });

  it('does not partial-match', () => {
    expect(isAdminLogin('serge', makeEnv('serge-ivo'))).toBe(false);
  });
});
