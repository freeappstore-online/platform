import { describe, expect, it } from 'vitest';
import { computeRoles } from '../routes/auth.js';
import { hasInternalToken, isAdminLogin, requireUser } from './auth.js';
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

describe('computeRoles admin (#22)', () => {
  // D1 stand-in: no apps, no app_roles rows.
  const DB = {
    prepare: () => ({
      bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }),
    }),
  };
  const makeEnv = (vars: { ADMIN_GITHUB_LOGINS?: string; ADMIN_USER_IDS?: string }) =>
    ({ DB, ...vars }) as any;

  it('grants admin to a Google user whose stable id is in ADMIN_USER_IDS', async () => {
    const env = makeEnv({ ADMIN_USER_IDS: 'gh:1, google:1234567890' });
    const { roles } = await computeRoles('google:1234567890', 'serge', env, 'google');
    expect(roles).toContain('admin');
  });

  it('matches ADMIN_USER_IDS case-insensitively', async () => {
    const env = makeEnv({ ADMIN_USER_IDS: 'Google:ABC' });
    const { roles } = await computeRoles('google:abc', 'x', env, 'google');
    expect(roles).toContain('admin');
  });

  it('does not grant admin to a Google user whose email local part matches an admin GitHub login', async () => {
    const env = makeEnv({ ADMIN_GITHUB_LOGINS: 'serge-ivo', ADMIN_USER_IDS: 'google:1234567890' });
    const { roles } = await computeRoles('google:999', 'serge-ivo', env, 'google');
    expect(roles).toEqual(['user']);
  });

  it('does not grant admin to email or Apple users by login either', async () => {
    const env = makeEnv({ ADMIN_GITHUB_LOGINS: 'serge-ivo' });
    expect((await computeRoles('email:x', 'serge-ivo', env, 'email')).roles).not.toContain('admin');
    expect((await computeRoles('apple:x', 'serge-ivo', env, 'apple')).roles).not.toContain('admin');
  });

  it('still grants admin to GitHub users by login', async () => {
    const env = makeEnv({ ADMIN_GITHUB_LOGINS: 'serge-ivo' });
    expect((await computeRoles('gh:42', 'serge-ivo', env)).roles).toContain('admin');
    expect((await computeRoles('gh:43', 'someone-else', env)).roles).toEqual(['user']);
  });

  it('grants admin to GitHub users by stable id too', async () => {
    const env = makeEnv({ ADMIN_USER_IDS: 'gh:42' });
    expect((await computeRoles('gh:42', 'renamed', env)).roles).toContain('admin');
  });

  it('grants nothing extra when neither list is set', async () => {
    const env = makeEnv({});
    expect((await computeRoles('google:1', 'serge-ivo', env, 'google')).roles).toEqual(['user']);
  });
});

describe('requireUser githubLogin', () => {
  async function userFor(id: string, githubLogin: string) {
    const token = await signSession(id, KEY);
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id,
            github_login: githubLogin,
            avatar_url: null,
            display_name: null,
            email: null,
            date_of_birth: null,
          }),
        }),
      }),
    };
    const c = {
      req: { header: () => `Bearer ${token}` },
      env: { DB: db, SESSION_SIGNING_KEY: KEY },
    } as unknown as Parameters<typeof requireUser>[0];
    return requireUser(c);
  }

  it('is the GitHub username for GitHub accounts', async () => {
    expect((await userFor('gh:42', 'octocat')).githubLogin).toBe('octocat');
  });

  it.each(['email:serge-ivo@attacker.example', 'google:123', 'apple:456'])(
    'is empty for %s, whose github_login is an email local-part',
    async (id) => {
      const user = await userFor(id, 'serge-ivo');
      expect(user.githubLogin).toBe('');
      expect(user.login).toBe('serge-ivo');
    },
  );
});

describe('hasInternalToken', () => {
  const ctx = (expected: string | undefined, provided: string | undefined) =>
    ({
      env: { ADMIN_PROVISION_TOKEN: expected },
      req: { header: () => provided },
    }) as unknown as Parameters<typeof hasInternalToken>[0];

  it('accepts the configured token', () => {
    expect(hasInternalToken(ctx('s3cret', 's3cret'))).toBe(true);
  });

  it.each([
    ['wrong token', 's3cret', 's3creX'],
    ['missing header', 's3cret', undefined],
    ['unconfigured secret', undefined, undefined],
    ['unconfigured secret, empty header', '', ''],
  ])('rejects %s', (_label, expected, provided) => {
    expect(hasInternalToken(ctx(expected, provided))).toBe(false);
  });
});
