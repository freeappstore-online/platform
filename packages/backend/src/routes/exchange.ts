import { Hono } from 'hono';
import { signSession } from '../lib/session.js';
import type { Env } from '../types.js';
import { computeRoles } from './auth.js';

export const exchangeRoutes = new Hono<{ Bindings: Env }>();

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string | null;
}

/**
 * Swap a GitHub user access token (e.g. from the CLI's device flow) for a
 * fas session token, then upsert the user record in D1 and mint a session.
 *
 * Body: { githubToken: string }
 * Returns: { sessionToken: string, user: { id, login, avatarUrl } }
 *
 * The CLI calls this once after `fas login` completes the device flow, so
 * subsequent CLI commands (publish, kv, ...) use a fas session token like
 * the browser SDK does.
 *
 * SECURITY (#47): the token is verified with GitHub's app-authenticated
 * check-token endpoint, NOT with `GET /user`. `/user` answers 200 for *any*
 * valid GitHub credential — a token minted for someone else's OAuth app, or a
 * leaked PAT — so authenticating that way let any such token be swapped for a
 * full FAS session belonging to its owner, who may never have authorized FAS
 * at all (confused deputy / audience confusion). `POST /applications/{id}/token`
 * returns 200 only for tokens issued to *this* client_id, and 404 otherwise.
 * Ported from the same fix in PAS (proappstore-online/platform#84).
 *
 * The identity comes out of the introspection response rather than a second
 * call, so the user we mint for is by construction the user the checked token
 * belongs to.
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

  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.text('token exchange is not configured', 503);
  }

  const introRes = await fetch(
    `https://api.github.com/applications/${c.env.GITHUB_CLIENT_ID}/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${c.env.GITHUB_CLIENT_ID}:${c.env.GITHUB_CLIENT_SECRET}`)}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'freeappstore-api',
      },
      body: JSON.stringify({ access_token: githubToken }),
    },
  );
  // A 5xx is GitHub being unwell, not a verdict on the token. Keep it a 502 so
  // an outage doesn't tell the user to go and re-authenticate.
  if (introRes.status >= 500) return c.text(`github error: ${introRes.status}`, 502);
  // 404 = not issued to this app; 422 = malformed; 401 = our own app
  // credentials are wrong. All of them mean "don't mint a session".
  if (introRes.status !== 200) {
    return c.text('github token was not issued to this application', 401);
  }
  const intro = (await introRes.json().catch(() => null)) as { user?: GitHubUser } | null;
  const ghUser = intro?.user;
  if (!ghUser) return c.text('invalid github token', 401);

  const userId = `gh:${ghUser.id}`;
  await c.env.DB.prepare(
    `INSERT INTO users (id, github_id, github_login, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       avatar_url = excluded.avatar_url`,
  )
    .bind(userId, ghUser.id, ghUser.login, ghUser.avatar_url ?? null, Date.now())
    .run();

  const dobRow = await c.env.DB.prepare('SELECT date_of_birth FROM users WHERE id = ?')
    .bind(userId)
    .first<{ date_of_birth: string | null }>();

  const { roles, appRoles } = await computeRoles(userId, ghUser.login, c.env);
  const sessionToken = await signSession(userId, c.env.SESSION_SIGNING_KEY, { roles, appRoles });

  return c.json({
    sessionToken,
    user: {
      id: userId,
      login: ghUser.login,
      avatarUrl: ghUser.avatar_url ?? null,
      dateOfBirth: dobRow?.date_of_birth ?? null,
    },
  });
});
