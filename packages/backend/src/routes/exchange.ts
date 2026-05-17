import { Hono } from 'hono';
import { signSession } from '../lib/session.js';
import type { Env } from '../types.js';

export const exchangeRoutes = new Hono<{ Bindings: Env }>();

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string | null;
}

/**
 * Swap a GitHub user access token (e.g. from the CLI's device flow) for a
 * fas session token. Verifies the GitHub token by calling GitHub's /user
 * endpoint, then upserts the user record in D1 and mints a session.
 *
 * Body: { githubToken: string }
 * Returns: { sessionToken: string, user: { id, login, avatarUrl } }
 *
 * The CLI calls this once after `fas login` completes the device flow, so
 * subsequent CLI commands (publish, kv, ...) use a fas session token like
 * the browser SDK does.
 */
exchangeRoutes.post('/auth/exchange', async (c) => {
  let body: { githubToken?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.text('invalid json', 400);
  }
  const githubToken = body.githubToken;
  if (!githubToken || typeof githubToken !== 'string') {
    return c.text('missing githubToken', 400);
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'freeappstore-api',
    },
  });
  if (userRes.status === 401) return c.text('invalid github token', 401);
  if (!userRes.ok) return c.text(`github error: ${userRes.status}`, 502);
  const ghUser = (await userRes.json()) as GitHubUser;

  const userId = `gh:${ghUser.id}`;
  await c.env.DB.prepare(
    `INSERT INTO users (id, github_id, github_login, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       avatar_url = excluded.avatar_url`,
  )
    .bind(userId, ghUser.id, ghUser.login, ghUser.avatar_url, Date.now())
    .run();

  const sessionToken = await signSession(userId, c.env.SESSION_SIGNING_KEY);

  return c.json({
    sessionToken,
    user: { id: userId, login: ghUser.login, avatarUrl: ghUser.avatar_url },
  });
});
