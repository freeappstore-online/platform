import type { Context } from 'hono';
import type { Env } from '../types.js';
import { verifySession } from './session.js';

export interface CurrentUser {
  id: string;
  /** Display-oriented name: display_name if set, otherwise github_login. */
  login: string;
  /** Always the GitHub username — use this for ownership checks, collaborator APIs, admin login matching. */
  githubLogin: string;
  avatarUrl: string | null;
  /** ISO 'YYYY-MM-DD'. Null until the user has set it through any app. */
  dateOfBirth: string | null;
  /** Platform-level roles: 'user', 'creator', 'admin'. */
  roles: string[];
  /** Per-app roles assigned by app creators: { appId: ['moderator', ...] }. */
  appRoles: Record<string, string[]>;
}

export async function requireUser(c: Context<{ Bindings: Env }>): Promise<CurrentUser> {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw new HttpError(401, 'missing bearer token');
  }
  const token = auth.slice('Bearer '.length);
  const payload = await verifySession(token, c.env.SESSION_SIGNING_KEY);
  if (!payload) throw new HttpError(401, 'invalid or expired session');

  const row = await c.env.DB.prepare(
    'SELECT id, github_login, avatar_url, display_name, email, date_of_birth FROM users WHERE id = ?',
  )
    .bind(payload.uid)
    .first<{
      id: string;
      github_login: string;
      avatar_url: string | null;
      display_name: string | null;
      email: string | null;
      date_of_birth: string | null;
    }>();

  // Cross-store identities (e.g. PAS `cred:*`) legitimately have no FAS user
  // row — the token signature is verified, so synthesize a user to let
  // kv/rooms/counters/roles work for them without a FAS row.
  //
  // But a FAS-NATIVE uid with no row means the account was deleted (or never
  // existed). We must NOT resurrect it as a synthetic authorized user — that
  // would silently undo `DELETE /v1/auth/me` (and any future ban), keeping the
  // token working with its baked roles for the rest of its TTL. Reject instead.
  //
  // We also never honor cross-store `admin`/`creator` claims: those are
  // FAS-computed, so a token minted by another store (shared signing key) can't
  // vote itself into FAS privilege.
  if (!row) {
    if (/^(gh|google|apple|email):/.test(payload.uid)) {
      throw new HttpError(401, 'account not found');
    }
    const crossStoreRoles = (payload.roles ?? ['user']).filter(
      (r) => r !== 'admin' && r !== 'creator',
    );
    return {
      id: payload.uid,
      login: payload.login ?? payload.uid,
      githubLogin: '',
      avatarUrl: null,
      dateOfBirth: null,
      roles: crossStoreRoles.length ? crossStoreRoles : ['user'],
      appRoles: payload.appRoles ?? {},
    };
  }

  return {
    id: row.id,
    login: row.display_name || row.github_login,
    githubLogin: row.github_login,
    avatarUrl: row.avatar_url,
    dateOfBirth: row.date_of_birth,
    roles: payload.roles ?? ['user'],
    appRoles: payload.appRoles ?? {},
  };
}

/**
 * Require a platform admin. Checks the 'admin' role in the session
 * token claims. The role is computed at sign-in from the
 * ADMIN_GITHUB_LOGINS env var, so no env-var parsing happens per request.
 */
export async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<CurrentUser> {
  const user = await requireUser(c);
  if (!user.roles.includes('admin') && !isAdminLogin(user.githubLogin, c.env)) {
    throw new HttpError(403, 'admin only');
  }
  return user;
}

/**
 * Require a specific platform role. Reads from session token claims.
 */
export async function requireRole(
  c: Context<{ Bindings: Env }>,
  role: string,
): Promise<CurrentUser> {
  const user = await requireUser(c);
  if (!user.roles.includes(role)) {
    throw new HttpError(403, `requires role: ${role}`);
  }
  return user;
}

/**
 * Check if a user id is in the admin list (env var). Used at sign-in
 * to compute the 'admin' role for the session token.
 */
export function isAdminLogin(login: string, env: Env): boolean {
  const admins = (env.ADMIN_GITHUB_LOGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(login.toLowerCase());
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}
