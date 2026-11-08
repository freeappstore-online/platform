import type { Context } from 'hono';
import type { Env } from '../types.js';
import {
  CONSOLE_AUD,
  CROSS_STORE_AUD,
  LEGACY_AUD,
  timingSafeEqual,
  verifySession,
} from './session.js';

/**
 * Sessions minted before #495 carry no `aud`. They keep working on the
 * app-data routes (`requireAppUser`) until this instant and are refused by the
 * console-only routes (`requireConsoleUser`) from the first deploy. Every such
 * token expires ≤30 days after the deploy anyway; the cutoff only shortens the
 * window. Delete the `legacy` branches once it has passed.
 */
export const LEGACY_AUD_CUTOFF = Date.UTC(2026, 10, 20); // 2026-11-20T00:00:00Z

export interface CurrentUser {
  id: string;
  /**
   * Which surface this session was delivered to (#495): an app id, `console`
   * for the first-party surfaces, or `legacy` for a pre-#495 token. Decides
   * what the session may call — see requireAppUser / requireConsoleUser.
   * (`legacy` here is LEGACY_AUD, `#legacy`: outside the app-id alphabet.)
   */
  aud: string;
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

const USER_COLUMNS =
  'SELECT id, github_login, avatar_url, display_name, email, date_of_birth, sessions_valid_after FROM users';

interface UserRow {
  id: string;
  github_login: string;
  avatar_url: string | null;
  display_name: string | null;
  email: string | null;
  date_of_birth: string | null;
  sessions_valid_after: number | null;
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
  const aud = payload.aud ?? LEGACY_AUD;

  const row = await c.env.DB.prepare(`${USER_COLUMNS} WHERE id = ?`)
    .bind(payload.uid)
    .first<UserRow>();

  // Revocation (#495): `POST /v1/auth/logout` moves sessions_valid_after to
  // now, so every session issued before it is dead on the next request. Same
  // row the lookup above already fetched — no extra I/O.
  if (row?.sessions_valid_after && payload.iat <= row.sessions_valid_after) {
    throw new HttpError(401, 'session revoked');
  }

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
    if (/^(gh|google|apple|email|em):/.test(payload.uid)) {
      throw new HttpError(401, 'account not found');
    }
    const crossStoreRoles = (payload.roles ?? ['user']).filter(
      (r) => r !== 'admin' && r !== 'creator',
    );
    return {
      id: payload.uid,
      // A cross-store token is never first-party here, whatever it claims.
      aud: aud === CONSOLE_AUD ? CROSS_STORE_AUD : aud,
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
    aud,
    login: row.display_name || row.github_login,
    // Non-GitHub providers store the email local-part in github_login. It is
    // attacker-chosen, so it must never match an app owner or admin login
    // (same rule as computeRoles).
    githubLogin: /^(google|apple|email|em):/.test(row.id) ? '' : row.github_login,
    avatarUrl: row.avatar_url,
    dateOfBirth: row.date_of_birth,
    roles: payload.roles ?? ['user'],
    appRoles: payload.appRoles ?? {},
  };
}

/**
 * A session that may touch `appId`'s data (#495): one delivered to that app,
 * or a first-party (`console`) one. A session delivered to another app is
 * refused, so an XSS in — or a malicious — app A cannot read app B's kv.
 * Legacy tokens pass until LEGACY_AUD_CUTOFF.
 */
export async function requireAppUser<E extends { Bindings: Env }>(
  c: Context<E>,
  appId: string,
): Promise<CurrentUser> {
  const user = await requireUser(c);
  if (user.aud === appId || user.aud === CONSOLE_AUD) return user;
  if (user.aud === LEGACY_AUD) {
    if (Date.now() < LEGACY_AUD_CUTOFF) return user;
    throw new HttpError(401, 'session_reissue_required');
  }
  throw new HttpError(403, 'wrong_audience');
}

/**
 * A first-party session (#495): signed in on the storefront, console, admin,
 * MCP or CLI. Required for everything that reaches beyond one app — publish,
 * app settings, the key vault, account deletion, admin. A legacy token is
 * 401 (not 403) so the stored copy is cleared and the user signs in again.
 */
export async function requireConsoleUser<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<CurrentUser> {
  const user = await requireUser(c);
  if (user.aud === CONSOLE_AUD) return user;
  if (user.aud === LEGACY_AUD) throw new HttpError(401, 'session_reissue_required');
  throw new HttpError(403, 'console_session_required');
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
 * SQL predicate for the FreeAppStore's own rows in the shared `apps` table.
 * PAS registers `store = 'apps_pro'` rows there too, whose ids can collide with
 * FAS ids (#571), so every FAS ownership read filters on it.
 */
export const FAS_APP_ROWS = "(store IS NULL OR store = 'apps')";

/**
 * Whether `user` owns an app whose immutable `apps.owner_id` is `ownerId`
 * (`gh:<numeric GitHub id>`, #566). Never the login: a GitHub username is
 * mutable and can be re-registered by someone else. A null owner_id (not yet
 * bound to an account) is owned by nobody.
 */
export function isAppOwner(user: Pick<CurrentUser, 'id'>, ownerId: string | null): boolean {
  return !!ownerId && user.id === ownerId;
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
  const row = await env.DB.prepare(`SELECT owner_id FROM apps WHERE id = ? AND ${FAS_APP_ROWS}`)
    .bind(appId)
    .first<{ owner_id: string | null }>();
  if (!row) throw new HttpError(404, 'app not found');
  if (opts.allowAdmin && isAdmin(user, env)) return;
  if (!isAppOwner(user, row.owner_id)) throw new HttpError(403, 'not the app owner');
}

/** Require a platform admin (decided live — see isAdmin) on a first-party session. */
export async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<CurrentUser> {
  const user = await requireConsoleUser(c);
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

/**
 * Require the signed-in user to own `appId`: 404 if no such app, 403 if not
 * theirs. The session may be the app's own or first-party — for owner actions
 * the SDK exposes inside the app (webhooks, roles).
 */
export async function requireAppOwner(
  c: Context<{ Bindings: Env }>,
  appId: string,
): Promise<CurrentUser> {
  const user = await requireAppUser(c, appId);
  await assertAppOwner(c.env, user, appId);
  return user;
}

/**
 * Owner of `appId` on a first-party session: app settings that an app's own
 * (possibly compromised) page must never reach — secrets, allowlist, analytics
 * config (`custom_head`), log reads.
 */
export async function requireConsoleAppOwner(
  c: Context<{ Bindings: Env }>,
  appId: string,
): Promise<CurrentUser> {
  const user = await requireConsoleUser(c);
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

/**
 * Whether a GitHub login is in ADMIN_GITHUB_LOGINS. Empty never matches.
 *
 * Transitional (#566): a username is mutable and re-registrable, so admin
 * belongs on the immutable id. Until ADMIN_USER_IDS carries at least one
 * `gh:<id>` entry the login list still applies, so deploying this can't lock
 * every admin out; once a `gh:` id is configured the login list is ignored.
 */
export function isAdminLogin(login: string, env: Env): boolean {
  if (hasGithubAdminId(env)) return false;
  const admins = (env.ADMIN_GITHUB_LOGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(login.toLowerCase());
}

function hasGithubAdminId(env: Env): boolean {
  return (env.ADMIN_USER_IDS ?? '')
    .split(',')
    .some((s) => s.trim().toLowerCase().startsWith('gh:'));
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
