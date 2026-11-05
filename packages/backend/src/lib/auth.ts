import type { Context } from 'hono';
import type { Env } from '../types.js';
import { timingSafeEqual, verifySession } from './session.js';

export interface CurrentUser {
  id: string;
  /** Display-oriented name: display_name if set, otherwise github_login. */
  login: string;
  /** Always the GitHub username — use this for ownership checks, collaborator APIs, admin login matching. */
  githubLogin: string;
  avatarUrl: string | null;
  /** ISO 'YYYY-MM-DD'. Null until the user has set it through any app. */
  dateOfBirth: string | null;
  /**
   * Platform roles ('user', 'creator', 'admin') as baked into the session token
   * at sign-in — up to 30 days stale. Never authorize on these: use isAdmin /
   * assertAppOwner / the app_roles table.
   */
  roles: string[];
  /** Per-app roles from the token at sign-in: { appId: ['moderator', ...] }. Same caveat as `roles`. */
  appRoles: Record<string, string[]>;
}

export async function requireUser<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<CurrentUser> {
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
    // Non-GitHub providers store the email local-part in github_login. It is
    // attacker-chosen, so it must never match an app owner or admin login
    // (same rule as computeRoles).
    githubLogin: /^(google|apple|email):/.test(row.id) ? '' : row.github_login,
    avatarUrl: row.avatar_url,
    dateOfBirth: row.date_of_birth,
    roles: payload.roles ?? ['user'],
    appRoles: payload.appRoles ?? {},
  };
}

/**
 * Platform admin, decided live from ADMIN_GITHUB_LOGINS / ADMIN_USER_IDS —
 * never from the session token's `roles` claim, which is baked in at sign-in
 * and outlives removal from the lists. Zero I/O.
 */
export function isAdmin(user: Pick<CurrentUser, 'id' | 'githubLogin'>, env: Env): boolean {
  return isAdminLogin(user.githubLogin, env) || isAdminUserId(user.id, env);
}

/**
 * Whether `user` owns an app whose `apps.owner_login` is `ownerLogin`. GitHub
 * logins are case-insensitive. An empty githubLogin (non-GitHub identity) never
 * owns anything.
 */
export function isAppOwner(
  user: Pick<CurrentUser, 'githubLogin'>,
  ownerLogin: string | null,
): boolean {
  return (
    !!user.githubLogin &&
    !!ownerLogin &&
    ownerLogin.toLowerCase() === user.githubLogin.toLowerCase()
  );
}

/**
 * 404 if `appId` doesn't exist, 403 unless `user` owns it (or, with
 * `allowAdmin`, is a live platform admin).
 */
export async function assertAppOwner(
  env: Env,
  user: CurrentUser,
  appId: string,
  opts: { allowAdmin?: boolean } = {},
): Promise<void> {
  // Existence first, even for admins: otherwise an admin can mint app_roles
  // rows for an app id that doesn't exist (#442).
  const row = await env.DB.prepare('SELECT owner_login FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ owner_login: string | null }>();
  if (!row) throw new HttpError(404, 'app not found');
  if (opts.allowAdmin && isAdmin(user, env)) return;
  if (!isAppOwner(user, row.owner_login)) throw new HttpError(403, 'not the app owner');
}

/** Require a platform admin (decided live — see isAdmin). */
export async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<CurrentUser> {
  const user = await requireUser(c);
  if (!isAdmin(user, c.env)) {
    console.warn('admin_denied', {
      userId: user.id,
      login: user.login,
      githubLogin: user.githubLogin,
      hasAdminGithubLogins: !!c.env.ADMIN_GITHUB_LOGINS,
      hasAdminUserIds: !!c.env.ADMIN_USER_IDS,
      path: c.req.path,
    });
    throw new HttpError(403, 'admin only');
  }
  console.log('admin_allowed', {
    userId: user.id,
    githubLogin: user.githubLogin,
    path: c.req.path,
  });
  return user;
}

/** Require the signed-in user to own `appId`: 404 if no such app, 403 if not theirs. */
export async function requireAppOwner(
  c: Context<{ Bindings: Env }>,
  appId: string,
): Promise<CurrentUser> {
  const user = await requireUser(c);
  await assertAppOwner(c.env, user, appId);
  return user;
}

/**
 * Service-to-service auth: the X-Internal-Token header must equal
 * ADMIN_PROVISION_TOKEN (constant-time compare). Used by the admin Worker,
 * which can't hold a user session.
 */
export function hasInternalToken(c: {
  env: Env;
  req: { header: (name: string) => string | undefined };
}): boolean {
  const expected = c.env.ADMIN_PROVISION_TOKEN;
  const provided = c.req.header('X-Internal-Token');
  return !!expected && !!provided && timingSafeEqual(provided, expected);
}

/** Whether a GitHub login is in ADMIN_GITHUB_LOGINS. Empty never matches. */
export function isAdminLogin(login: string, env: Env): boolean {
  const admins = (env.ADMIN_GITHUB_LOGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(login.toLowerCase());
}

export function isAdminUserId(userId: string, env: Env): boolean {
  const admins = (env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(userId.toLowerCase());
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}
