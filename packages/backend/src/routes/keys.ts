/**
 * User API Key Vault — encrypted per-user API keys for third-party services.
 *
 * Keys are managed on a platform-hosted page (GET /v1/keys), not inside
 * individual apps. Apps redirect users there via fas.keys.manage().
 *
 * API routes:
 *   GET    /v1/keys              → HTML key management page (or JSON list if Accept: application/json)
 *   GET    /v1/keys/providers    → list of supported providers
 *   GET    /v1/keys/status       → which providers the user has keys for
 *   PUT    /v1/keys/:provider    → store (or update) an encrypted key
 *   DELETE /v1/keys/:provider    → delete a stored key
 */

import { Hono } from 'hono';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { openSecret, sealSecret } from '../lib/encryption.js';
import type { Env } from '../types.js';

type AppEnv = { Bindings: Env };

export const keysRoutes = new Hono<AppEnv>();

const USER_ID_RE = /^[a-z][a-z0-9:_-]{1,127}$/i;
const AGENT_PROVIDER_TO_VAULT: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google-ai',
  openrouter: 'openrouter',
};
const VAULT_PROVIDER_TO_AGENT: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'google-ai': 'google',
  openrouter: 'openrouter',
};
const COMP_PROVIDERS = new Set(['anthropic', 'openai', 'google']);
const DEFAULT_COMP_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  google: 'gemini-2.5-flash',
};
const COMP_SCHEMA = `CREATE TABLE IF NOT EXISTS complimentary_grants (
  user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at TEXT
)`;
let compSchemaReady = false;

function hasInternalToken(c: { env: Env; req: { header: (name: string) => string | undefined } }) {
  const expected = c.env.ADMIN_PROVISION_TOKEN;
  const provided = c.req.header('X-Internal-Token');
  return !!expected && provided === expected;
}

async function ensureCompSchema(db: D1Database): Promise<void> {
  if (compSchemaReady) return;
  await db.prepare(COMP_SCHEMA).run();
  compSchemaReady = true;
}

function compKeyFor(env: Env, provider: string): string | null {
  const key =
    provider === 'anthropic'
      ? env.COMP_KEY_ANTHROPIC
      : provider === 'openai'
        ? env.COMP_KEY_OPENAI
        : provider === 'google'
          ? env.COMP_KEY_GOOGLE
          : null;
  return key?.trim() || null;
}

function rowToGrant(row: Record<string, unknown>) {
  return {
    userId: String(row.user_id),
    provider: String(row.provider),
    model: String(row.model),
    grantedBy: String(row.granted_by),
    note: row.note ? String(row.note) : null,
    createdAt: Number(row.created_at) || 0,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
  };
}

async function listCompGrants(env: Env) {
  await ensureCompSchema(env.DB);
  const rows = await env.DB.prepare(
    `SELECT user_id, provider, model, granted_by, note, created_at, expires_at
     FROM complimentary_grants
     ORDER BY created_at DESC`,
  ).all<Record<string, unknown>>();
  return rows.results.map(rowToGrant);
}

async function getActiveCompGrant(env: Env, userId: string) {
  await ensureCompSchema(env.DB);
  const row = await env.DB.prepare(
    `SELECT user_id, provider, model, granted_by, note, created_at, expires_at
     FROM complimentary_grants
     WHERE user_id = ?`,
  )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const grant = rowToGrant(row);
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
    await env.DB.prepare('DELETE FROM complimentary_grants WHERE user_id = ?')
      .bind(userId)
      .run()
      .catch(() => {});
    return null;
  }
  return grant;
}

// ── Providers list (public, no auth) ──────────────────────────────────

keysRoutes.get('/keys/providers', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, docs_url, key_prefix FROM key_providers ORDER BY name',
  ).all<{ id: string; name: string; docs_url: string | null; key_prefix: string | null }>();
  return c.json({ providers: rows.results });
});

// ── Internal admin key provisioning ───────────────────────────────────

keysRoutes.get('/internal/keys/providers', async (c) => {
  if (!hasInternalToken(c)) return c.json({ error: 'forbidden' }, 403);
  const rows = await c.env.DB.prepare(
    'SELECT id, name, docs_url, key_prefix FROM key_providers ORDER BY name',
  ).all<{ id: string; name: string; docs_url: string | null; key_prefix: string | null }>();
  return c.json({ providers: rows.results });
});

keysRoutes.get('/internal/keys/users', async (c) => {
  if (!hasInternalToken(c)) return c.json({ error: 'forbidden' }, 403);

  const grants = await listCompGrants(c.env);
  const grantsByUser = new Map(grants.map((grant) => [grant.userId, grant]));
  const [usersRes, keysRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, github_login, display_name, avatar_url, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 1000`,
    ).all<{
      id: string;
      github_login: string;
      display_name: string | null;
      avatar_url: string | null;
      created_at: number | null;
    }>(),
    c.env.DB.prepare(
      `SELECT user_id, provider, label, created_at, last_used_at
       FROM user_api_keys
       ORDER BY provider`,
    )
      .all<{
        user_id: string;
        provider: string;
        label: string | null;
        created_at: number;
        last_used_at: number | null;
      }>()
      .catch(() => ({ results: [] })),
  ]);

  const keysByUser = new Map<
    string,
    Array<{ provider: string; label: string | null; createdAt: number; lastUsedAt: number | null }>
  >();
  for (const key of keysRes.results) {
    const keys = keysByUser.get(key.user_id) ?? [];
    keys.push({
      provider: key.provider,
      label: key.label,
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at,
    });
    keysByUser.set(key.user_id, keys);
  }

  return c.json({
    users: usersRes.results.map((user) => ({
      id: user.id,
      githubLogin: user.github_login,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
      keys: keysByUser.get(user.id) ?? [],
      grant: grantsByUser.get(user.id) ?? null,
    })),
  });
});

keysRoutes.get('/internal/keys/grants', async (c) => {
  if (!hasInternalToken(c)) return c.json({ error: 'forbidden' }, 403);
  const funded = [...COMP_PROVIDERS].filter((provider) => !!compKeyFor(c.env, provider));
  const grants = await listCompGrants(c.env);
  return c.json({ grants, funded });
});

keysRoutes.post('/internal/keys/grants', async (c) => {
  if (!hasInternalToken(c)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req
    .json<{
      userId?: string;
      provider?: string;
      model?: string;
      note?: string;
      expiresAt?: string | null;
      grantedBy?: string;
    }>()
    .catch(() => null);
  const userId = String(body?.userId ?? '').trim();
  const provider = String(body?.provider ?? '')
    .trim()
    .toLowerCase();
  const model = String(body?.model ?? DEFAULT_COMP_MODELS[provider] ?? '').trim();
  const note = body?.note ? String(body.note).trim().slice(0, 200) : null;
  const expiresAt = body?.expiresAt ? String(body.expiresAt).trim() : null;
  const grantedBy = body?.grantedBy ? String(body.grantedBy).trim().slice(0, 120) : 'admin';

  if (!USER_ID_RE.test(userId))
    return c.json({ ok: false, error: 'valid userId is required' }, 400);
  if (!COMP_PROVIDERS.has(provider))
    return c.json({ ok: false, error: `unknown grant provider: ${provider}` }, 400);
  if (!model || model.length > 128)
    return c.json({ ok: false, error: 'valid model is required' }, 400);
  if (expiresAt && Number.isNaN(Date.parse(expiresAt)))
    return c.json({ ok: false, error: 'expiresAt must be an ISO date' }, 400);
  const funded = !!compKeyFor(c.env, provider);

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string }>();
  if (!user) return c.json({ ok: false, error: 'user not found' }, 404);

  await ensureCompSchema(c.env.DB);
  await c.env.DB.prepare(
    `INSERT INTO complimentary_grants (user_id, provider, model, granted_by, note, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       granted_by = excluded.granted_by,
       note = excluded.note,
       expires_at = excluded.expires_at`,
  )
    .bind(userId, provider, model, grantedBy, note, Date.now(), expiresAt)
    .run();
  return c.json({ ok: true, userId, provider, model, expiresAt, funded });
});

keysRoutes.post('/internal/keys/grants/delete', async (c) => {
  if (!hasInternalToken(c)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json<{ userId?: string }>().catch(() => null);
  const userId = String(body?.userId ?? '').trim();
  if (!USER_ID_RE.test(userId))
    return c.json({ ok: false, error: 'valid userId is required' }, 400);
  await ensureCompSchema(c.env.DB);
  const result = await c.env.DB.prepare('DELETE FROM complimentary_grants WHERE user_id = ?')
    .bind(userId)
    .run();
  return c.json({ ok: true, removed: (result.meta?.changes ?? 0) > 0 });
});

// ── Product-session admin grant management ────────────────────────────
// These routes power create.freeappstore.online/admin using the normal FAS
// session token. They avoid the separate Cloudflare Access login on the admin
// Worker, while still requiring the platform admin role.

keysRoutes.get('/admin/ai-grants/users', async (c) => {
  await requireAdmin(c);

  const grants = await listCompGrants(c.env);
  const grantsByUser = new Map(grants.map((grant) => [grant.userId, grant]));
  const [usersRes, keysRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, github_login, display_name, avatar_url, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 1000`,
    ).all<{
      id: string;
      github_login: string;
      display_name: string | null;
      avatar_url: string | null;
      created_at: number | null;
    }>(),
    c.env.DB.prepare(
      `SELECT user_id, provider, label, created_at, last_used_at
       FROM user_api_keys
       ORDER BY provider`,
    )
      .all<{
        user_id: string;
        provider: string;
        label: string | null;
        created_at: number;
        last_used_at: number | null;
      }>()
      .catch(() => ({ results: [] })),
  ]);

  const keysByUser = new Map<
    string,
    Array<{ provider: string; label: string | null; createdAt: number; lastUsedAt: number | null }>
  >();
  for (const key of keysRes.results) {
    const keys = keysByUser.get(key.user_id) ?? [];
    keys.push({
      provider: key.provider,
      label: key.label,
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at,
    });
    keysByUser.set(key.user_id, keys);
  }

  return c.json({
    users: usersRes.results.map((user) => ({
      id: user.id,
      githubLogin: user.github_login,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
      keys: keysByUser.get(user.id) ?? [],
      grant: grantsByUser.get(user.id) ?? null,
    })),
  });
});

keysRoutes.get('/admin/ai-grants', async (c) => {
  await requireAdmin(c);
  const funded = [...COMP_PROVIDERS].filter((provider) => !!compKeyFor(c.env, provider));
  const grants = await listCompGrants(c.env);
  return c.json({ grants, funded });
});

keysRoutes.post('/admin/ai-grants', async (c) => {
  const admin = await requireAdmin(c);
  const body = await c.req
    .json<{
      userId?: string;
      provider?: string;
      model?: string;
      note?: string;
      expiresAt?: string | null;
    }>()
    .catch(() => null);
  const userId = String(body?.userId ?? '').trim();
  const provider = String(body?.provider ?? '')
    .trim()
    .toLowerCase();
  const model = String(body?.model ?? DEFAULT_COMP_MODELS[provider] ?? '').trim();
  const note = body?.note ? String(body.note).trim().slice(0, 200) : null;
  const expiresAt = body?.expiresAt ? String(body.expiresAt).trim() : null;

  if (!USER_ID_RE.test(userId))
    return c.json({ ok: false, error: 'valid userId is required' }, 400);
  if (!COMP_PROVIDERS.has(provider))
    return c.json({ ok: false, error: `unknown grant provider: ${provider}` }, 400);
  if (!model || model.length > 128)
    return c.json({ ok: false, error: 'valid model is required' }, 400);
  if (expiresAt && Number.isNaN(Date.parse(expiresAt)))
    return c.json({ ok: false, error: 'expiresAt must be an ISO date' }, 400);
  const funded = !!compKeyFor(c.env, provider);

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string }>();
  if (!user) return c.json({ ok: false, error: 'user not found' }, 404);

  await ensureCompSchema(c.env.DB);
  await c.env.DB.prepare(
    `INSERT INTO complimentary_grants (user_id, provider, model, granted_by, note, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       granted_by = excluded.granted_by,
       note = excluded.note,
       expires_at = excluded.expires_at`,
  )
    .bind(userId, provider, model, admin.githubLogin || admin.login, note, Date.now(), expiresAt)
    .run();
  return c.json({ ok: true, userId, provider, model, expiresAt, funded });
});

keysRoutes.post('/admin/ai-grants/delete', async (c) => {
  await requireAdmin(c);
  const body = await c.req.json<{ userId?: string }>().catch(() => null);
  const userId = String(body?.userId ?? '').trim();
  if (!USER_ID_RE.test(userId))
    return c.json({ ok: false, error: 'valid userId is required' }, 400);
  await ensureCompSchema(c.env.DB);
  const result = await c.env.DB.prepare('DELETE FROM complimentary_grants WHERE user_id = ?')
    .bind(userId)
    .run();
  return c.json({ ok: true, removed: (result.meta?.changes ?? 0) > 0 });
});

keysRoutes.post('/admin/ai-keys', async (c) => {
  await requireAdmin(c);
  if (!c.env.APP_SECRET_KEK) {
    return c.json({ ok: false, error: 'Key vault not configured (APP_SECRET_KEK missing).' }, 503);
  }

  const body = await c.req
    .json<{ userId?: string; provider?: string; key?: string; label?: string }>()
    .catch(() => null);
  const userId = String(body?.userId ?? '').trim();
  const provider = String(body?.provider ?? '')
    .trim()
    .toLowerCase();
  const key = String(body?.key ?? '').trim();
  const label = body?.label ? String(body.label).trim().slice(0, 80) : 'Admin provisioned';

  if (!USER_ID_RE.test(userId))
    return c.json({ ok: false, error: 'valid userId is required' }, 400);
  if (!key || key.length > 500)
    return c.json({ ok: false, error: 'Invalid key value (max 500 chars).' }, 400);

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string }>();
  if (!user) return c.json({ ok: false, error: 'user not found' }, 404);

  const prov = await c.env.DB.prepare('SELECT id, key_prefix FROM key_providers WHERE id = ?')
    .bind(provider)
    .first<{ id: string; key_prefix: string | null }>();
  if (!prov) return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400);
  if (prov.key_prefix && !key.startsWith(prov.key_prefix)) {
    return c.json(
      {
        ok: false,
        error: `Key should start with "${prov.key_prefix}". Check you copied the full key.`,
      },
      400,
    );
  }

  const sealed = await sealSecret(key, c.env.APP_SECRET_KEK);
  await c.env.DB.prepare(
    `INSERT INTO user_api_keys (user_id, provider, label, key_ciphertext, dek_wrapped, iv, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       label = excluded.label,
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       created_at = excluded.created_at`,
  )
    .bind(userId, provider, label, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, Date.now())
    .run();

  return c.json({ ok: true, userId, provider });
});

keysRoutes.post('/admin/ai-keys/delete', async (c) => {
  await requireAdmin(c);
  const body = await c.req.json<{ userId?: string; provider?: string }>().catch(() => null);
  const userId = String(body?.userId ?? '').trim();
  const provider = String(body?.provider ?? '')
    .trim()
    .toLowerCase();
  if (!USER_ID_RE.test(userId) || !provider) {
    return c.json({ ok: false, error: 'userId and provider are required' }, 400);
  }

  const result = await c.env.DB.prepare(
    'DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?',
  )
    .bind(userId, provider)
    .run();
  return c.json({ ok: true, removed: (result.meta?.changes ?? 0) > 0 });
});

keysRoutes.post('/internal/keys/userkey', async (c) => {
  if (!hasInternalToken(c)) return c.json({ error: 'forbidden' }, 403);
  if (!c.env.APP_SECRET_KEK) {
    return c.json({ ok: false, error: 'Key vault not configured (APP_SECRET_KEK missing).' }, 503);
  }

  const body = await c.req
    .json<{ userId?: string; provider?: string; key?: string; label?: string }>()
    .catch(() => null);
  const userId = String(body?.userId ?? '').trim();
  const provider = String(body?.provider ?? '')
    .trim()
    .toLowerCase();
  const key = String(body?.key ?? '').trim();
  const label = body?.label ? String(body.label).trim().slice(0, 80) : null;

  if (!USER_ID_RE.test(userId))
    return c.json({ ok: false, error: 'valid userId is required' }, 400);
  if (!key || key.length > 500)
    return c.json({ ok: false, error: 'Invalid key value (max 500 chars).' }, 400);

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string }>();
  if (!user) return c.json({ ok: false, error: 'user not found' }, 404);

  const prov = await c.env.DB.prepare('SELECT id, key_prefix FROM key_providers WHERE id = ?')
    .bind(provider)
    .first<{ id: string; key_prefix: string | null }>();
  if (!prov) return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400);
  if (prov.key_prefix && !key.startsWith(prov.key_prefix)) {
    return c.json(
      {
        ok: false,
        error: `Key should start with "${prov.key_prefix}". Check you copied the full key.`,
      },
      400,
    );
  }

  const sealed = await sealSecret(key, c.env.APP_SECRET_KEK);
  await c.env.DB.prepare(
    `INSERT INTO user_api_keys (user_id, provider, label, key_ciphertext, dek_wrapped, iv, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       label = excluded.label,
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       created_at = excluded.created_at`,
  )
    .bind(userId, provider, label, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, Date.now())
    .run();

  return c.json({ ok: true, userId, provider });
});

keysRoutes.post('/internal/keys/userkey/delete', async (c) => {
  if (!hasInternalToken(c)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json<{ userId?: string; provider?: string }>().catch(() => null);
  const userId = String(body?.userId ?? '').trim();
  const provider = String(body?.provider ?? '')
    .trim()
    .toLowerCase();
  if (!USER_ID_RE.test(userId) || !provider) {
    return c.json({ ok: false, error: 'userId and provider are required' }, 400);
  }

  const result = await c.env.DB.prepare(
    'DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?',
  )
    .bind(userId, provider)
    .run();
  return c.json({ ok: true, removed: (result.meta?.changes ?? 0) > 0 });
});

// ── Key status (which providers user has keys for) ────────────────────

keysRoutes.get('/keys/status', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT provider, label, created_at, last_used_at FROM user_api_keys WHERE user_id = ?',
  )
    .bind(user.id)
    .all<{
      provider: string;
      label: string | null;
      created_at: number;
      last_used_at: number | null;
    }>();
  return c.json({
    keys: rows.results.map((r) => ({
      provider: r.provider,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  });
});

// ── Usage (daily proxy calls via user keys) ──────────────────────────

keysRoutes.get('/keys/usage', async (c) => {
  const user = await requireUser(c);
  const today = new Date().toISOString().slice(0, 10);
  const row = await c.env.DB.prepare(
    'SELECT count FROM app_proxy_usage WHERE app_id = ? AND day = ?',
  )
    .bind(`userkey:${user.id}`, today)
    .first<{ count: number }>();
  return c.json({ used: row?.count ?? 0, limit: 1000, day: today });
});

// ── Store / update a key ──────────────────────────────────────────────

keysRoutes.put('/keys/:provider', async (c) => {
  const user = await requireUser(c);
  if (!c.env.APP_SECRET_KEK) {
    return c.json({ ok: false, error: 'Key vault not configured (APP_SECRET_KEK missing).' }, 503);
  }

  const provider = c.req.param('provider');
  const body = await c.req.json<{ value: string; label?: string }>();
  if (!body.value || typeof body.value !== 'string' || body.value.length > 500) {
    return c.json({ ok: false, error: 'Invalid key value (max 500 chars).' }, 400);
  }

  // Validate provider exists
  const prov = await c.env.DB.prepare('SELECT id, key_prefix FROM key_providers WHERE id = ?')
    .bind(provider)
    .first<{ id: string; key_prefix: string | null }>();
  if (!prov) {
    return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400);
  }

  // Optional prefix validation
  if (prov.key_prefix && !body.value.startsWith(prov.key_prefix)) {
    return c.json(
      {
        ok: false,
        error: `Key should start with "${prov.key_prefix}". Check you copied the full key.`,
      },
      400,
    );
  }

  const sealed = await sealSecret(body.value, c.env.APP_SECRET_KEK);
  await c.env.DB.prepare(
    `INSERT INTO user_api_keys (user_id, provider, label, key_ciphertext, dek_wrapped, iv, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       label = excluded.label,
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       created_at = excluded.created_at`,
  )
    .bind(
      user.id,
      provider,
      body.label ?? null,
      sealed.keyCiphertext,
      sealed.dekWrapped,
      sealed.iv,
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
});

// ── Delete a key ──────────────────────────────────────────────────────

keysRoutes.delete('/keys/:provider', async (c) => {
  const user = await requireUser(c);

  const provider = c.req.param('provider');
  const result = await c.env.DB.prepare(
    'DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?',
  )
    .bind(user.id, provider)
    .run();

  return c.json({ ok: true, removed: (result.meta?.changes ?? 0) > 0 });
});

// ── Internal key resolve (for agent service binding) ──────────────────
// Called by the agent worker via service binding. Not public-facing.
// The agent sends the user's session token + provider, we decrypt and return.

keysRoutes.get('/keys/resolve/:provider', async (c) => {
  // Internal-only: only callable via service binding (agent worker).
  // Service binding requests use a synthetic host (not the public domain),
  // so checking the Host header distinguishes internal from external calls.
  const host = c.req.header('host') ?? '';
  if (host.includes('freeappstore.online') || host.includes('localhost')) {
    return c.json({ error: 'this endpoint is internal-only' }, 403);
  }

  const user = await requireUser(c);
  if (!c.env.APP_SECRET_KEK) {
    return c.json({ key: null, error: 'vault not configured' }, 503);
  }
  const provider = c.req.param('provider');
  const key = await resolveUserKey(c.env.DB, user.id, provider, c.env.APP_SECRET_KEK);
  if (!key) return c.json({ key: null });
  return c.json({ key });
});

keysRoutes.get('/keys/resolve-agent/:provider', async (c) => {
  // Internal-only: only callable via service binding (agent worker).
  const host = c.req.header('host') ?? '';
  if (host.includes('freeappstore.online') || host.includes('localhost')) {
    return c.json({ error: 'this endpoint is internal-only' }, 403);
  }

  const user = await requireUser(c);
  if (!c.env.APP_SECRET_KEK) {
    return c.json({ key: null, source: 'none', error: 'vault not configured' }, 503);
  }

  const requestedProvider = c.req.param('provider');
  const vaultProvider = AGENT_PROVIDER_TO_VAULT[requestedProvider] ?? requestedProvider;
  const agentProvider = VAULT_PROVIDER_TO_AGENT[vaultProvider] ?? requestedProvider;
  const key = await resolveUserKey(c.env.DB, user.id, vaultProvider, c.env.APP_SECRET_KEK);
  if (key) {
    return c.json({ key, provider: agentProvider, source: 'vault' });
  }

  const grant = await getActiveCompGrant(c.env, user.id);
  if (!grant) return c.json({ key: null, source: 'none' });
  const grantKey = compKeyFor(c.env, grant.provider);
  if (!grantKey)
    return c.json({
      key: null,
      source: 'grant_unfunded',
      provider: grant.provider,
      model: grant.model,
    });

  return c.json({
    key: grantKey,
    provider: grant.provider,
    model: grant.model,
    source: 'grant',
    grantExpiresAt: grant.expiresAt,
  });
});

// ── Resolve a user's key (internal, used by proxy) ────────────────────

export async function resolveUserKey(
  db: D1Database,
  userId: string,
  provider: string,
  kek: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      'SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ? AND provider = ?',
    )
    .bind(userId, provider)
    .first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();

  if (!row) return null;

  const plaintext = await openSecret(
    {
      keyCiphertext: new Uint8Array(row.key_ciphertext),
      dekWrapped: new Uint8Array(row.dek_wrapped),
      iv: new Uint8Array(row.iv),
    },
    kek,
  );

  // Probabilistic last_used_at update (1 in 10)
  if (Math.random() < 0.1) {
    await db
      .prepare('UPDATE user_api_keys SET last_used_at = ? WHERE user_id = ? AND provider = ?')
      .bind(Date.now(), userId, provider)
      .run()
      .catch(() => {});
  }

  return plaintext;
}

// ── Key management page (server-rendered HTML) ────────────────────────

keysRoutes.get('/keys', async (c) => {
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json')) {
    // API mode: return JSON status
    const user = await requireUser(c);
    const rows = await c.env.DB.prepare(
      'SELECT provider, label, created_at, last_used_at FROM user_api_keys WHERE user_id = ?',
    )
      .bind(user.id)
      .all<{
        provider: string;
        label: string | null;
        created_at: number;
        last_used_at: number | null;
      }>();
    return c.json({ keys: rows.results });
  }

  // HTML mode: render the key management page.
  // returnUrl is attacker-supplied — only allow http(s) or same-origin relative
  // paths, so a `javascript:`/`data:` scheme can't become a clickable XSS link.
  const returnUrlRaw = c.req.query('return') ?? '';
  const returnUrl =
    /^https?:\/\//i.test(returnUrlRaw) || returnUrlRaw.startsWith('/') ? returnUrlRaw : '';
  const provider = c.req.query('provider') ?? '';
  const appId = c.req.query('app') ?? '';
  return c.html(renderKeysPage({ returnUrl, provider, appId }));
});

function renderKeysPage(opts: { returnUrl: string; provider: string; appId: string }): string {
  const { returnUrl, provider, appId } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API Keys — FreeAppStore</title>
  <style>
    :root { --accent: #2563eb; --bg: #ffffff; --surface: #f8fafc; --ink: #0f172a; --muted: #64748b; --border: #e2e8f0; --danger: #dc2626; --success: #16a34a; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0f172a; --surface: #1e293b; --ink: #f1f5f9; --muted: #94a3b8; --border: #334155; }
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 15px; line-height: 1.5; }
    .wrap { max-width: 32rem; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 1.5rem; font-weight: 800; margin: 0 0 0.25rem; }
    .sub { color: var(--muted); font-size: 0.85rem; margin-bottom: 1.5rem; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1rem; margin-bottom: 0.75rem; }
    .card h3 { margin: 0 0 0.25rem; font-size: 0.95rem; font-weight: 700; }
    .card .meta { font-size: 0.75rem; color: var(--muted); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 700; }
    .badge-on { background: #dcfce7; color: var(--success); }
    .badge-off { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }
    input[type="password"], input[type="text"] { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--bg); color: var(--ink); font-size: 0.85rem; font-family: inherit; margin: 0.5rem 0; }
    input:focus { outline: none; border-color: var(--accent); }
    .btn { display: inline-block; padding: 0.45rem 1rem; border: none; border-radius: 0.5rem; font-size: 0.85rem; font-weight: 600; cursor: pointer; font-family: inherit; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-ghost { background: transparent; color: var(--ink); border: 1px solid var(--border); }
    .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .alert { padding: 0.75rem 1rem; border-radius: 0.5rem; font-size: 0.85rem; margin-bottom: 1rem; }
    .alert-info { background: #eff6ff; color: #1d4ed8; border: 1px solid #93c5fd; }
    .back { display: inline-block; margin-top: 1.5rem; color: var(--accent); text-decoration: none; font-size: 0.85rem; font-weight: 600; }
    .docs-link { font-size: 0.75rem; color: var(--accent); text-decoration: none; }
    #status { font-size: 0.8rem; color: var(--muted); margin-top: 0.5rem; }
    .hidden { display: none; }
  </style>
</head>
<body>
<div class="wrap">
  <h1>API Keys</h1>
  <p class="sub">Your keys are encrypted and stored on the FreeAppStore platform. Apps never see them — they're injected server-side when apps make API calls through the proxy.</p>

  <div id="auth-gate" class="alert alert-info">Sign in to manage your API keys.</div>
  <div id="keys-list" class="hidden"></div>
  <div id="status"></div>

  ${returnUrl ? `<a class="back" href="${escapeAttr(returnUrl)}">Back to ${escapeAttr(appId || 'app')}</a>` : ''}
</div>
<script>
(function() {
  var API = '/v1';
  var token = null;
  var highlightProvider = ${JSON.stringify(provider).replace(/</g, '\\u003c')};

  // Get session token from cookie or localStorage
  function getToken() {
    try {
      var stored = localStorage.getItem('fas_session');
      if (stored) { var p = JSON.parse(stored); if (p && p.token) return p.token; }
    } catch (_) {}
    return null;
  }

  function headers() {
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  }

  function setStatus(msg) { document.getElementById('status').textContent = msg; }

  async function load() {
    token = getToken();
    if (!token) return;
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('keys-list').classList.remove('hidden');

    var [provRes, statusRes] = await Promise.all([
      fetch(API + '/keys/providers', { headers: headers() }),
      fetch(API + '/keys/status', { headers: headers() }),
    ]);
    var providers = (await provRes.json()).providers || [];
    var existing = (await statusRes.json()).keys || [];
    var existingMap = {};
    existing.forEach(function(k) { existingMap[k.provider] = k; });

    var html = '';
    providers.forEach(function(p) {
      var has = !!existingMap[p.id];
      var highlight = p.id === highlightProvider ? ' style="border-color: var(--accent); box-shadow: 0 0 0 2px rgba(37,99,235,0.15);"' : '';
      html += '<div class="card" id="card-' + p.id + '"' + highlight + '>';
      html += '<div class="row"><div>';
      html += '<h3>' + esc(p.name) + '</h3>';
      if (p.docs_url) html += '<a class="docs-link" href="' + esc(p.docs_url) + '" target="_blank" rel="noopener">Get API key &#8599;</a>';
      html += '</div>';
      html += '<span class="badge ' + (has ? 'badge-on' : 'badge-off') + '">' + (has ? 'configured' : 'not set') + '</span>';
      html += '</div>';
      if (has) {
        html += '<p class="meta">Added ' + new Date(existingMap[p.id].created_at).toLocaleDateString() + '</p>';
        html += '<div class="actions">';
        html += '<button class="btn btn-ghost" onclick="editKey(\\''+p.id+'\\')">Update</button>';
        html += '<button class="btn btn-danger" onclick="deleteKey(\\''+p.id+'\\')">Remove</button>';
        html += '</div>';
      } else {
        html += '<div class="actions"><button class="btn btn-primary" onclick="editKey(\\''+p.id+'\\')">Add key</button></div>';
      }
      html += '<div id="form-' + p.id + '" class="hidden" style="margin-top:0.75rem">';
      html += '<input type="password" id="input-' + p.id + '" placeholder="Paste your ' + esc(p.name) + ' API key">';
      html += '<div class="actions">';
      html += '<button class="btn btn-primary" onclick="saveKey(\\''+p.id+'\\')">Save</button>';
      html += '<button class="btn btn-ghost" onclick="cancelEdit(\\''+p.id+'\\')">Cancel</button>';
      html += '</div></div>';
      html += '</div>';
    });
    document.getElementById('keys-list').innerHTML = html;

    if (highlightProvider) {
      var el = document.getElementById('card-' + highlightProvider);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  window.editKey = function(id) {
    document.getElementById('form-' + id).classList.remove('hidden');
    document.getElementById('input-' + id).focus();
  };
  window.cancelEdit = function(id) {
    document.getElementById('form-' + id).classList.add('hidden');
    document.getElementById('input-' + id).value = '';
  };
  window.saveKey = async function(id) {
    var val = document.getElementById('input-' + id).value.trim();
    if (!val) return;
    setStatus('Saving...');
    var res = await fetch(API + '/keys/' + id, { method: 'PUT', headers: headers(), body: JSON.stringify({ value: val }) });
    var data = await res.json();
    if (data.ok) { setStatus('Saved!'); load(); }
    else { setStatus('Error: ' + (data.error || 'unknown')); }
  };
  window.deleteKey = async function(id) {
    if (!confirm('Remove this API key?')) return;
    setStatus('Removing...');
    var res = await fetch(API + '/keys/' + id, { method: 'DELETE', headers: headers() });
    var data = await res.json();
    if (data.ok) { setStatus('Removed.'); load(); }
    else { setStatus('Error: ' + (data.error || 'unknown')); }
  };

  load();
})();
</script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[<>"'&]/g, (c) => `&#${c.charCodeAt(0)};`);
}
