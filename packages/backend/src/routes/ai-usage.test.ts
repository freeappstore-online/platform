// #16: AI usage + funding-source auditability on the backend side. The key
// resolver says what funded a turn and stamps last-used; admin listings expose
// usage and filter by funding source; nothing ever returns key material.

import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { sealSecret } from '../lib/encryption.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);
const KEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const USER_KEY = 'sk-ant-user-secret-123';
const PLATFORM_KEY = 'sk-ant-platform-secret-456';

type Stmt = { sql: string; binds: unknown[] };

interface State {
  user: Record<string, unknown>;
  sealedKey?: Record<string, unknown> | null;
  provisionedBy?: string | null;
  provisionedByThrows?: boolean;
  grant?: Record<string, unknown> | null;
  provider?: Record<string, unknown> | null;
  all?: Array<[needle: string, rows: Array<Record<string, unknown>>]>;
  count?: number;
}

/** Routes each statement by its SQL and records every one of them. */
function fakeDB(state: State, stmts: Stmt[]) {
  return {
    prepare: (sql: string) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      let binds: unknown[] = [];
      const record = () => stmts.push({ sql: q, binds });
      const stmt = {
        first: async () => {
          record();
          if (q.includes('SELECT key_ciphertext')) return state.sealedKey ?? null;
          if (q.includes('SELECT provisioned_by')) {
            if (state.provisionedByThrows) throw new Error('no such column: provisioned_by');
            return { provisioned_by: state.provisionedBy ?? null };
          }
          if (q.includes('FROM complimentary_grants')) return state.grant ?? null;
          if (q.includes('FROM key_providers')) return state.provider ?? null;
          if (q.includes('COUNT(*)')) return { n: state.count ?? 0 };
          if (q.includes('FROM users')) return state.user;
          return null;
        },
        all: async () => {
          record();
          for (const [needle, rows] of state.all ?? [])
            if (q.includes(needle)) return { results: rows };
          return { results: [] };
        },
        run: async () => {
          record();
          return { meta: { changes: 1 } };
        },
      };
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          binds = args;
          return stmt;
        },
      };
    },
  } as unknown as D1Database;
}

const ALICE = {
  id: 'gh:1',
  github_login: 'alice',
  display_name: null,
  avatar_url: null,
  date_of_birth: null,
};
const OPS = {
  id: 'admin-1',
  github_login: 'ops',
  display_name: null,
  avatar_url: null,
  date_of_birth: null,
};

async function sealedRow(plaintext: string) {
  const sealed = await sealSecret(plaintext, KEK);
  return { key_ciphertext: sealed.keyCiphertext, dek_wrapped: sealed.dekWrapped, iv: sealed.iv };
}

async function request(
  path: string,
  init: RequestInit & { as: 'alice' | 'admin' },
  db: D1Database,
) {
  const token =
    init.as === 'admin'
      ? await signSession('admin-1', SIGNING_KEY, { roles: ['admin'] })
      : await signSession('gh:1', SIGNING_KEY);
  const { as: _as, ...rest } = init;
  return app.request(
    `https://backend${path}`,
    {
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(rest.headers ?? {}),
      },
    },
    {
      DB: db,
      SESSION_SIGNING_KEY: SIGNING_KEY,
      APP_SECRET_KEK: KEK,
      COMP_KEY_ANTHROPIC: PLATFORM_KEY,
    },
  );
}

const resolveAgent = (db: D1Database) =>
  request('/v1/keys/resolve-agent/anthropic', { as: 'alice' }, db);

describe('resolve-agent says what funded the turn (#16)', () => {
  it("the user's own vault key is vault_user, and its last_used_at is stamped", async () => {
    const stmts: Stmt[] = [];
    const res = await resolveAgent(
      fakeDB({ user: ALICE, sealedKey: await sealedRow(USER_KEY), provisionedBy: null }, stmts),
    );

    expect(await res.json()).toEqual({
      key: USER_KEY,
      provider: 'anthropic',
      source: 'vault_user',
    });
    const stamp = stmts.find((s) => s.sql.startsWith('UPDATE user_api_keys SET last_used_at'));
    expect(stamp?.binds.slice(1)).toEqual(['gh:1', 'anthropic']);
  });

  it('a key an admin provisioned is vault_admin', async () => {
    const res = await resolveAgent(
      fakeDB({ user: ALICE, sealedKey: await sealedRow(USER_KEY), provisionedBy: 'ops' }, []),
    );
    expect(((await res.json()) as { source: string }).source).toBe('vault_admin');
  });

  it('still returns the key when provenance cannot be read (before the migration)', async () => {
    const res = await resolveAgent(
      fakeDB({ user: ALICE, sealedKey: await sealedRow(USER_KEY), provisionedByThrows: true }, []),
    );
    expect(await res.json()).toEqual({
      key: USER_KEY,
      provider: 'anthropic',
      source: 'vault_user',
    });
  });

  it("a complimentary grant is 'grant', and the grant's last_used_at is stamped", async () => {
    const stmts: Stmt[] = [];
    const grant = {
      user_id: 'gh:1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      granted_by: 'ops',
      note: null,
      created_at: 1,
      expires_at: null,
    };
    const res = await resolveAgent(fakeDB({ user: ALICE, sealedKey: null, grant }, stmts));

    const body = (await res.json()) as { key: string; source: string };
    expect(body.source).toBe('grant');
    expect(body.key).toBe(PLATFORM_KEY);
    const stamp = stmts.find((s) =>
      s.sql.startsWith('UPDATE complimentary_grants SET last_used_at'),
    );
    expect(stamp?.binds[1]).toBe('gh:1');
  });

  it("no key and no grant is 'none'", async () => {
    const res = await resolveAgent(fakeDB({ user: ALICE, sealedKey: null, grant: null }, []));
    expect(await res.json()).toEqual({ key: null, source: 'none' });
  });
});

describe('provisioned_by records who put a key in the vault (#16)', () => {
  const upsertOf = (stmts: Stmt[]) =>
    stmts.find((s) => s.sql.startsWith('INSERT INTO user_api_keys'));

  it('an admin-provisioned key records the admin', async () => {
    const stmts: Stmt[] = [];
    const db = fakeDB({ user: OPS, provider: { id: 'anthropic', key_prefix: 'sk-ant-' } }, stmts);
    const res = await request(
      '/v1/admin/ai-keys',
      {
        as: 'admin',
        method: 'POST',
        body: JSON.stringify({ userId: 'gh:1', provider: 'anthropic', key: USER_KEY }),
      },
      db,
    );

    expect(res.status).toBe(200);
    expect(upsertOf(stmts)?.binds.at(-1)).toBe('ops');
    expect(upsertOf(stmts)?.sql).toContain('provisioned_by = excluded.provisioned_by');
  });

  it("a user saving their own key clears it, even over an admin's key", async () => {
    const stmts: Stmt[] = [];
    const db = fakeDB({ user: ALICE, provider: { id: 'anthropic', key_prefix: 'sk-ant-' } }, stmts);
    const res = await request(
      '/v1/keys/anthropic',
      { as: 'alice', method: 'PUT', body: JSON.stringify({ value: USER_KEY }) },
      db,
    );

    expect(res.status).toBe(200);
    expect(upsertOf(stmts)?.binds.at(-1)).toBeNull();
  });
});

describe('admin usage views (#16)', () => {
  it('the Grants listing shows provenance, last-used and grant usage, and no key material', async () => {
    const stmts: Stmt[] = [];
    const db = fakeDB(
      {
        user: OPS,
        all: [
          [
            'GROUP BY user_id',
            [{ user_id: 'gh:1', sessions: 2, input_tokens: 1200, output_tokens: 340 }],
          ],
          [
            'FROM complimentary_grants',
            [
              {
                user_id: 'gh:1',
                provider: 'anthropic',
                model: 'm',
                granted_by: 'ops',
                note: null,
                created_at: 1,
                expires_at: null,
                last_used_at: 99,
              },
            ],
          ],
          [
            'FROM user_api_keys',
            [
              {
                user_id: 'gh:1',
                provider: 'openai',
                label: 'Admin provisioned',
                created_at: 1,
                last_used_at: 50,
                provisioned_by: 'ops',
              },
            ],
          ],
          ['FROM users', [ALICE]],
        ],
      },
      stmts,
    );
    const res = await request('/v1/admin/ai-grants/users', { as: 'admin' }, db);
    const text = await res.text();
    const { users } = JSON.parse(text);

    expect(users[0].keys[0]).toEqual({
      provider: 'openai',
      label: 'Admin provisioned',
      createdAt: 1,
      lastUsedAt: 50,
      provisionedBy: 'ops',
    });
    expect(users[0].grant).toMatchObject({
      lastUsedAt: 99,
      usage: { sessions: 2, inputTokens: 1200, outputTokens: 340 },
    });
    // Grant usage is summed from the sessions the grant funded.
    expect(stmts.find((s) => s.sql.includes("ai_source = 'grant'"))).toBeDefined();
    // Never key material: the listing doesn't even select it.
    expect(
      stmts
        .filter((s) => s.sql.includes('FROM user_api_keys'))
        .every((s) => !s.sql.includes('key_ciphertext')),
    ).toBe(true);
    expect(text).not.toMatch(/sk-ant|key_ciphertext|dek_wrapped/);
  });

  it('the Sessions list carries usage and filters by funding source', async () => {
    const stmts: Stmt[] = [];
    const row = {
      session_id: 's1',
      user_id: 'gh:1',
      name: 'Dict',
      input_tokens: 1500,
      output_tokens: 400,
      ai_provider: 'anthropic',
      ai_model: 'claude-sonnet-4-6',
      ai_source: 'grant',
    };
    const db = fakeDB({ user: OPS, all: [['FROM agent_sessions s', [row]]], count: 1 }, stmts);

    const res = await request(
      '/v1/admin/agent-sessions?funded_by=grant&q=dict',
      { as: 'admin' },
      db,
    );
    const { sessions } = (await res.json()) as { sessions: Array<Record<string, unknown>> };

    expect(sessions[0]).toMatchObject({
      inputTokens: 1500,
      outputTokens: 400,
      aiProvider: 'anthropic',
      aiModel: 'claude-sonnet-4-6',
      aiSource: 'grant',
    });
    const list = stmts.find(
      (s) => s.sql.includes('FROM agent_sessions s') && s.sql.includes('LIMIT'),
    );
    expect(list?.sql).toContain('WHERE (s.name LIKE ?');
    expect(list?.sql).toContain('AND s.ai_source = ?');
    expect(list?.binds).toContain('grant');
  });

  it("maps funded_by=admin_key to the 'vault_admin' source, and rejects unknown values", async () => {
    const stmts: Stmt[] = [];
    await request(
      '/v1/admin/agent-sessions?funded_by=admin_key',
      { as: 'admin' },
      fakeDB({ user: OPS }, stmts),
    );
    expect(stmts.find((s) => s.sql.includes('s.ai_source = ?'))?.binds).toContain('vault_admin');

    const bad = await request(
      '/v1/admin/agent-sessions?funded_by=stolen',
      { as: 'admin' },
      fakeDB({ user: OPS }, []),
    );
    expect(bad.status).toBe(400);
  });

  it('the Users list shows per-source usage and filters to users a grant funded', async () => {
    const stmts: Stmt[] = [];
    const db = fakeDB(
      {
        user: OPS,
        count: 1,
        all: [
          [
            'GROUP BY user_id, ai_source',
            [
              {
                user_id: 'gh:1',
                ai_source: 'grant',
                sessions: 3,
                input_tokens: 900,
                output_tokens: 90,
              },
            ],
          ],
          ['FROM users', [{ id: 'gh:1', github_login: 'alice' }]],
        ],
      },
      stmts,
    );

    const res = await request('/v1/admin/users?funded_by=grant', { as: 'admin' }, db);
    const { users } = (await res.json()) as { users: Array<Record<string, unknown>> };

    expect(users[0]?.aiUsage).toEqual([
      { source: 'grant', sessions: 3, inputTokens: 900, outputTokens: 90 },
    ]);
    const list = stmts.find(
      (s) => s.sql.includes('FROM users') && s.sql.includes('LIMIT ? OFFSET ?'),
    );
    expect(list?.sql).toContain(
      'WHERE id IN (SELECT user_id FROM agent_sessions WHERE ai_source = ?)',
    );
    expect(list?.binds[0]).toBe('grant');
  });
});
