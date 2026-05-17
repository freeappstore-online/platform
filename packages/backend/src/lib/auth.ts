import type { Context } from 'hono';
import type { Env } from '../types.js';
import { verifySession } from './session.js';

export interface CurrentUser {
  id: string;
  login: string;
  avatarUrl: string | null;
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
    'SELECT id, github_login, avatar_url, display_name, email FROM users WHERE id = ?',
  )
    .bind(payload.uid)
    .first<{
      id: string;
      github_login: string;
      avatar_url: string | null;
      display_name: string | null;
      email: string | null;
    }>();
  if (!row) throw new HttpError(401, 'user not found');

  return { id: row.id, login: row.display_name || row.github_login, avatarUrl: row.avatar_url };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}
