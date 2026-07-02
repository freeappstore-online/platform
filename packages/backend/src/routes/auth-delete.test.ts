import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(capture: { batched?: string[] } = {}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const stmt = {
        _sql: trimmed,
        bind: (..._a: unknown[]) => stmt,
        first: async () =>
          trimmed.includes('FROM users')
            ? { id: 'u1', github_login: 'alice', avatar_url: null, display_name: null, email: null, date_of_birth: null }
            : null,
        run: async () => ({ meta: { changes: 1 } }),
      };
      return stmt;
    },
    batch: async (stmts: Array<{ _sql: string }>) => {
      capture.batched = stmts.map((s) => s._sql);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

describe('DELETE /v1/auth/me', () => {
  it('401s without auth', async () => {
    const res = await app.request('/v1/auth/me', { method: 'DELETE' }, env(fakeDB()));
    expect(res.status).toBe(401);
  });

  it('deletes the user + personal data across the expected tables', async () => {
    const capture: { batched?: string[] } = {};
    const token = await signSession('u1', SIGNING_KEY);
    const res = await app.request(
      '/v1/auth/me',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env(fakeDB(capture)),
    );
    expect(res.status).toBe(200);
    const joined = (capture.batched ?? []).join(' | ');
    // Every user-scoped table must be swept, and the users row deleted last.
    for (const t of [
      'DELETE FROM user_api_keys',
      'DELETE FROM kv',
      'DELETE FROM friendships',
      'DELETE FROM app_roles',
      'DELETE FROM documents',
      'DELETE FROM app_logs',
      'DELETE FROM users',
    ]) {
      expect(joined).toContain(t);
    }
    expect(capture.batched?.[capture.batched.length - 1]).toContain('DELETE FROM users');
  });
});
