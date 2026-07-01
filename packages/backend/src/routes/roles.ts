import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import { timingSafeEqual } from '../lib/session.js';
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
  const user = await requireUser(c);
  const appId = c.req.param('appId');
  await assertAppOwnerOrAdmin(c, user, appId);

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
  const user = await requireUser(c);
  const appId = c.req.param('appId');
  const targetUserId = c.req.param('userId');

  // Users can check their own roles; owners/admins can check anyone's
  if (targetUserId !== user.id) {
    await assertAppOwnerOrAdmin(c, user, appId);
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
  const user = await requireUser(c);
  const appId = c.req.param('appId');
  await assertAppOwnerOrAdmin(c, user, appId);

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
  const user = await requireUser(c);
  const appId = c.req.param('appId');
  await assertAppOwnerOrAdmin(c, user, appId);

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
  const user = await requireUser(c);
  const appId = c.req.param('appId');
  const role = c.req.param('role');

  // Check token claims first (fast path)
  const tokenRoles = user.appRoles?.[appId] ?? [];
  if (tokenRoles.includes(role)) {
    return c.json({ has: true, source: 'token' });
  }

  // Fall back to DB (token might be stale)
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
  const user = await requireUser(c);
  const appId = c.req.param('appId');

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

/**
 * Service-to-service role assignment via HMAC proof. Used by PAS invite
 * redeem to assign a role without requiring owner auth. The caller
 * proves knowledge of SESSION_SIGNING_KEY by providing:
 *   proof = HMAC-SHA256("claim:{appId}:{userId}:{role}", key)
 */
rolesRoutes.post('/apps/:appId/roles/service-assign', async (c) => {
  const appId = c.req.param('appId');
  const body = (await c.req.json().catch(() => null)) as {
    userId?: string;
    role?: string;
    proof?: string;
    grantedBy?: string;
  } | null;

  if (!body?.userId || !body?.role || !body?.proof) {
    return c.json({ error: 'userId, role, and proof are required' }, 400);
  }
  if (body.role === 'owner') {
    return c.json({ error: "cannot assign 'owner' via service" }, 400);
  }

  const enc = new TextEncoder();
  const message = `claim:${appId}:${body.userId}:${body.role}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(c.env.SESSION_SIGNING_KEY) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message) as BufferSource);
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  if (!timingSafeEqual(body.proof, expected)) {
    return c.json({ error: 'invalid proof' }, 403);
  }

  await c.env.DB.prepare(
    `INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, user_id, role_name) DO NOTHING`,
  )
    .bind(appId, body.userId, body.role, body.grantedBy ?? null)
    .run();

  return c.json({ ok: true });
});

/**
 * Assert the user is the app creator or a platform admin.
 * Checks owner_login (github username) in the apps table.
 */
async function assertAppOwnerOrAdmin(
  c: { env: Env },
  user: { id: string; githubLogin: string; roles: string[] },
  appId: string,
): Promise<void> {
  if (user.roles.includes('admin')) return;

  const row = await c.env.DB.prepare('SELECT owner_login FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ owner_login: string }>();
  if (!row) throw new HttpError(404, 'app not found');
  if (row.owner_login !== user.githubLogin) {
    throw new HttpError(403, 'only the app owner or admin can manage roles');
  }
}
