import type { Context } from 'hono';
import type { Env } from '../types.js';
import { verifySession } from './session.js';

export interface CurrentUser {
  id: string;
  login: string;
  avatarUrl: string | null;
  /** ISO 'YYYY-MM-DD'. Null until the user has set it through any app. */
  dateOfBirth: string | null;
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
  if (!row) throw new HttpError(401, 'user not found');

  return {
    id: row.id,
    login: row.display_name || row.github_login,
    avatarUrl: row.avatar_url,
    dateOfBirth: row.date_of_birth,
  };
}

/**
 * Require a platform admin. Subset of authenticated users whose GitHub
 * login appears in the comma-separated `ADMIN_GITHUB_LOGINS` env var.
 * Used to gate cross-app analytics aggregation, abuse audits, etc.
 *
 * The env var is optional — when unset, no user is admin and this
 * always 403s. Set on the deployed Worker via `wrangler secret put
 * ADMIN_GITHUB_LOGINS` with a single name like "serge-ivo" or a
 * comma-separated list.
 */
export async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<CurrentUser> {
  const user = await requireUser(c);
  const env = c.env as Env & { ADMIN_GITHUB_LOGINS?: string };
  const admins = (env.ADMIN_GITHUB_LOGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!admins.includes(user.login.toLowerCase())) {
    throw new HttpError(403, 'admin only');
  }
  return user;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}
