import { Hono } from 'hono';
import { appExists } from '../lib/apps.js';
import { assertAppOwner, isAppOwner, requireAppUser } from '../lib/auth.js';
import { hmac, timingSafeEqual } from '../lib/session.js';
import type { Env } from '../types.js';

/**
 * App-level RBAC endpoints. Manages role assignments per app.
 *
 * Default roles (convention, not enforced at DB level):
 *   owner      — auto-assigned to app creator, full control
 *   member     — auto-assigned on first app sign-in
 *   moderator  — content moderation, user management
 *   editor     — CRUD on app data, not settings
 *   viewer     — read-only access
 *
 * Custom roles: devs can assign any string as a role name.
 */
export const rolesRoutes = new Hono<{ Bindings: Env }>();

/** List all role assignments for an app. Caller must be app owner or admin. */
rolesRoutes.get('/apps/:appId/roles', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const appId = c.req.param('appId');
  await assertAppOwner(c.env, user, appId, { allowAdmin: true });

  const { results } = await c.env.DB.prepare(
    'SELECT user_id, role_name, granted_by, granted_at FROM app_roles WHERE app_id = ? ORDER BY granted_at',
  )
    .bind(appId)
    .all<{ user_id: string; role_name: string; granted_by: string | null; granted_at: number }>();

  // Map to the camelCase shape the SDK's RoleAssignment expects. Without this
  // every field reads back undefined and Roles.list(role) — which filters on
  // r.roleName — always returns []. (Matches keys/secrets/friends convention.)
  const roles = (results ?? []).map((r) => ({
    userId: r.user_id,
    roleName: r.role_name,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  }));

  return c.json({ roles });
});

/** List roles for a specific user in an app. Any authenticated user can check their own roles. */
rolesRoutes.get('/apps/:appId/roles/:userId', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const appId = c.req.param('appId');
  const targetUserId = c.req.param('userId');

  // Users can check their own roles; owners/admins can check anyone's
  if (targetUserId !== user.id) {
    await assertAppOwner(c.env, user, appId, { allowAdmin: true });
  }

  const { results } = await c.env.DB.prepare(
    'SELECT role_name, granted_by, granted_at FROM app_roles WHERE app_id = ? AND user_id = ?',
  )
    .bind(appId, targetUserId)
    .all<{ role_name: string; granted_by: string | null; granted_at: number }>();

  return c.json({ roles: (results ?? []).map((r) => r.role_name) });
});

/** Assign a role to a user. Caller must be app owner or admin. */
rolesRoutes.post('/apps/:appId/roles', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const appId = c.req.param('appId');
  await assertAppOwner(c.env, user, appId, { allowAdmin: true });

  const body = (await c.req.json().catch(() => null)) as {
    userId?: string;
    role?: string;
  } | null;

  if (!body?.userId || !body?.role) {
    return c.json({ error: 'userId and role are required' }, 400);
  }

  const { userId: targetUserId, role } = body;

  if (!/^[a-z][a-z0-9_-]{0,49}$/.test(role)) {
    return c.json(
      { error: 'role must be lowercase alphanumeric with hyphens/underscores, 1-50 chars' },
      400,
    );
  }

  // Cannot assign 'owner' — it's auto-managed
  if (role === 'owner') {
    return c.json({ error: "cannot assign 'owner' role — it is managed by the platform" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, user_id, role_name) DO NOTHING`,
  )
    .bind(appId, targetUserId, role, user.id)
    .run();

  return c.json({ ok: true, appId, userId: targetUserId, role });
});

/** Revoke a role from a user. Caller must be app owner or admin. */
rolesRoutes.delete('/apps/:appId/roles', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const appId = c.req.param('appId');
  await assertAppOwner(c.env, user, appId, { allowAdmin: true });

  const body = (await c.req.json().catch(() => null)) as {
    userId?: string;
    role?: string;
  } | null;

  if (!body?.userId || !body?.role) {
    return c.json({ error: 'userId and role are required' }, 400);
  }

  // Cannot revoke 'owner'
  if (body.role === 'owner') {
    return c.json({ error: "cannot revoke 'owner' role — transfer ownership instead" }, 400);
  }

  await c.env.DB.prepare('DELETE FROM app_roles WHERE app_id = ? AND user_id = ? AND role_name = ?')
    .bind(appId, body.userId, body.role)
    .run();

  return c.json({ ok: true });
});

/** Check if the caller has a specific role in an app. Returns { has: boolean }. */
rolesRoutes.get('/apps/:appId/roles/check/:role', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const appId = c.req.param('appId');
  const role = c.req.param('role');

  // DB is the truth: token appRoles are baked in at sign-in and go stale.
  // 'owner' isn't stored in app_roles — it is apps.owner_login (as in computeRoles).
  if (role === 'owner') {
    const app = await c.env.DB.prepare('SELECT owner_login FROM apps WHERE id = ?')
      .bind(appId)
      .first<{ owner_login: string | null }>();
    return c.json({ has: !!app && isAppOwner(user, app.owner_login), source: 'db' });
  }
  const row = await c.env.DB.prepare(
    'SELECT 1 FROM app_roles WHERE app_id = ? AND user_id = ? AND role_name = ? LIMIT 1',
  )
    .bind(appId, user.id, role)
    .first();

  return c.json({ has: row !== null, source: 'db' });
});

/**
 * Ensure the current user has at least the 'member' role in this app.
 * Called by the SDK on app.auth.init() — idempotent, no-op if any role exists.
 * No owner/admin gate: any authenticated user can become a member.
 */
rolesRoutes.post('/apps/:appId/roles/ensure-member', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const appId = c.req.param('appId');
  // Otherwise any string mints an app_roles row, and computeRoles copies every
  // row into the user's session token.
  if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);

  // Skip if user already has any role in this app
  const existing = await c.env.DB.prepare(
    'SELECT 1 FROM app_roles WHERE app_id = ? AND user_id = ? LIMIT 1',
  )
    .bind(appId, user.id)
    .first();

  if (existing) return c.json({ ok: true, assigned: false });

  await c.env.DB.prepare(
    `INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
     VALUES (?, ?, 'member', NULL)
     ON CONFLICT(app_id, user_id, role_name) DO NOTHING`,
  )
    .bind(appId, user.id)
    .run();

  return c.json({ ok: true, assigned: true });
});

/** Longest a service-assign proof may be valid for. */
const SERVICE_PROOF_MAX_TTL_SECONDS = 300;

/** Length-prefixed fields: no value can shift into its neighbour (user ids contain ':'). */
function serviceAssignMessage(fields: string[]): string {
  return `fas:service-assign:v1|${fields.map((f) => `${f.length}:${f}`).join('|')}`;
}

/**
 * Service-to-service role assignment via HMAC proof, for a caller that holds
 * SESSION_SIGNING_KEY. The proof is single-use and short-lived (#463):
 *   proof = HMAC-SHA256(key, serviceAssignMessage([appId, userId, role, exp, nonce]))
 * with `exp` (unix seconds, at most 5 minutes ahead) and a caller-chosen
 * `nonce` (16-64 chars) sent alongside. A replayed proof is refused.
 */
rolesRoutes.post('/apps/:appId/roles/service-assign', async (c) => {
  const appId = c.req.param('appId');
  const body = (await c.req.json().catch(() => null)) as {
    userId?: unknown;
    role?: unknown;
    proof?: unknown;
    exp?: unknown;
    nonce?: unknown;
    grantedBy?: unknown;
  } | null;

  if (
    typeof body?.userId !== 'string' ||
    typeof body.role !== 'string' ||
    typeof body.proof !== 'string' ||
    typeof body.nonce !== 'string' ||
    typeof body.exp !== 'number' ||
    !body.userId ||
    !body.role ||
    !body.proof
  ) {
    return c.json({ error: 'userId, role, exp, nonce and proof are required' }, 400);
  }
  if (!/^[a-z][a-z0-9_-]{0,49}$/.test(body.role)) {
    return c.json(
      { error: 'role must be lowercase alphanumeric with hyphens/underscores, 1-50 chars' },
      400,
    );
  }
  if (body.role === 'owner') {
    return c.json({ error: "cannot assign 'owner' via service" }, 400);
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(body.nonce)) {
    return c.json({ error: 'nonce must be 16-64 url-safe characters' }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(body.exp) ||
    body.exp <= now ||
    body.exp > now + SERVICE_PROOF_MAX_TTL_SECONDS
  ) {
    return c.json({ error: 'proof expired or exp too far ahead' }, 403);
  }

  const expected = await hmac(
    serviceAssignMessage([appId, body.userId, body.role, String(body.exp), body.nonce]),
    c.env.SESSION_SIGNING_KEY,
  );
  if (!timingSafeEqual(body.proof, expected)) {
    return c.json({ error: 'invalid proof' }, 403);
  }

  // Only a valid proof reaches the existence check and the single-use burn.
  if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);
  try {
    await c.env.DB.prepare('INSERT INTO consumed_tokens (hash, expires_at) VALUES (?, ?)')
      .bind(`service-assign:${expected}`, body.exp)
      .run();
  } catch {
    return c.json({ error: 'proof already used' }, 403);
  }

  await c.env.DB.prepare(
    `INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, user_id, role_name) DO NOTHING`,
  )
    .bind(appId, body.userId, body.role, typeof body.grantedBy === 'string' ? body.grantedBy : null)
    .run();

  return c.json({ ok: true });
});
