import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  appCreator?: string | null;
  roles?: Array<Record<string, unknown>>;
  existingRole?: boolean;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const result = {
        first: async () => {
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('FROM apps')) return opts.appCreator != null ? { creator_id: opts.appCreator } : null;
          if (trimmed.includes('SELECT 1 FROM app_roles')) return opts.existingRole ? { 1: 1 } : null;
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM app_roles')) return { results: opts.roles ?? [] };
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return { ...result, bind: (..._args: unknown[]) => result };
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'u1') {
  const token = await signSession({ uid: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('roles routes', () => {
  const owner = { id: 'u1', github_login: 'owner', avatar_url: null, date_of_birth: null };

  // GET list roles
  it('GET /v1/apps/:appId/roles returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/roles', {}, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('GET /v1/apps/:appId/roles returns roles for app owner', async () => {
    const roles = [{ user_id: 'u2', role_name: 'editor', granted_by: 'u1', granted_at: 1000 }];
    const res = await app.request('/v1/apps/timer/roles', {
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user: owner, appCreator: 'u1', roles })));
    expect(res.status).toBe(200);
    const data = await res.json() as { roles: unknown[] };
    expect(data.roles).toHaveLength(1);
  });

  it('GET /v1/apps/:appId/roles returns 403 for non-owner', async () => {
    const nonOwner = { id: 'u2', github_login: 'other', avatar_url: null, date_of_birth: null };
    const res = await app.request('/v1/apps/timer/roles', {
      headers: { Authorization: await authHeader('u2') },
    }, env(fakeDB({ user: nonOwner, appCreator: 'u1' })));
    expect(res.status).toBe(403);
  });

  // GET user roles
  it('GET /v1/apps/:appId/roles/:userId returns own roles', async () => {
    const roles = [{ role_name: 'member', granted_by: null, granted_at: 1000 }];
    const res = await app.request('/v1/apps/timer/roles/u1', {
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user: owner, roles })));
    expect(res.status).toBe(200);
    const data = await res.json() as { roles: string[] };
    expect(data.roles).toContain('member');
  });

  // POST assign role
  it('POST /v1/apps/:appId/roles assigns role', async () => {
    const res = await app.request('/v1/apps/timer/roles', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u2', role: 'editor' }),
    }, env(fakeDB({ user: owner, appCreator: 'u1' })));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; role: string };
    expect(data.ok).toBe(true);
    expect(data.role).toBe('editor');
  });

  it('POST /v1/apps/:appId/roles rejects owner role assignment', async () => {
    const res = await app.request('/v1/apps/timer/roles', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u2', role: 'owner' }),
    }, env(fakeDB({ user: owner, appCreator: 'u1' })));
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/roles returns 400 without body', async () => {
    const res = await app.request('/v1/apps/timer/roles', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env(fakeDB({ user: owner, appCreator: 'u1' })));
    expect(res.status).toBe(400);
  });

  // DELETE revoke role
  it('DELETE /v1/apps/:appId/roles revokes role', async () => {
    const res = await app.request('/v1/apps/timer/roles', {
      method: 'DELETE',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u2', role: 'editor' }),
    }, env(fakeDB({ user: owner, appCreator: 'u1' })));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it('DELETE /v1/apps/:appId/roles rejects owner role revocation', async () => {
    const res = await app.request('/v1/apps/timer/roles', {
      method: 'DELETE',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u2', role: 'owner' }),
    }, env(fakeDB({ user: owner, appCreator: 'u1' })));
    expect(res.status).toBe(400);
  });

  // Role check
  it('GET /v1/apps/:appId/roles/check/:role checks DB', async () => {
    const res = await app.request('/v1/apps/timer/roles/check/editor', {
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user: owner, existingRole: true })));
    expect(res.status).toBe(200);
    const data = await res.json() as { has: boolean };
    expect(data.has).toBe(true);
  });

  // Ensure member
  it('POST /v1/apps/:appId/roles/ensure-member creates member role', async () => {
    const res = await app.request('/v1/apps/timer/roles/ensure-member', {
      method: 'POST',
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user: owner, existingRole: false })));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; assigned: boolean };
    expect(data.ok).toBe(true);
    expect(data.assigned).toBe(true);
  });

  it('POST /v1/apps/:appId/roles/ensure-member skips if already has role', async () => {
    const res = await app.request('/v1/apps/timer/roles/ensure-member', {
      method: 'POST',
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user: owner, existingRole: true })));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; assigned: boolean };
    expect(data.assigned).toBe(false);
  });
});
