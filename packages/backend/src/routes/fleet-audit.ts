import { Hono } from 'hono';
import { verifyGithubOidc } from '../lib/github-oidc.js';
import type { Env } from '../types.js';
import { APP_ORG_ID } from './deploy.js';

/**
 * Read-only data for the fleet consistency audit (#552):
 *
 *   GET /v1/audit/apps    Authorization: Bearer <GitHub Actions OIDC token>
 *     -> { apps: [{ id, repo, r2Prefix }], routesWithoutApps: [slug] }
 *
 * The caller is one workflow, not a user: no FAS session is minted or accepted
 * here (requireUser/requireAdmin are untouched), and the OIDC token is checked
 * on every request, so there is no stored credential to leak. Authorization is
 * on immutable ids: this platform repository, in this org, running exactly the
 * audit workflow on main, on a schedule or a manual dispatch. The audience is
 * the audit's own, so a deploy token (audience = the API origin) cannot read it.
 * Nothing returned is user data: no owner, email, session or secret.
 */

export const AUDIT_AUDIENCE = 'freeappstore-fleet-audit';
/** freeappstore-online/platform's immutable repository id. */
export const PLATFORM_REPO_ID = '1229373857';
export const AUDIT_WORKFLOW_REF =
  'freeappstore-online/platform/.github/workflows/fleet-consistency-audit.yml@refs/heads/main';
const AUDIT_REF = 'refs/heads/main';
const AUDIT_EVENTS = new Set(['schedule', 'workflow_dispatch']);
export const READS_PER_HOUR = 30;

/** Short reason codes for a token GitHub's verifier refused. */
const VERIFY_CODES: Array<[RegExp, string]> = [
  [/audience/, 'wrong_audience'],
  [/expired/, 'expired'],
  [/signature/, 'bad_signature'],
];

export const fleetAuditRoutes = new Hono<{ Bindings: Env }>();

fleetAuditRoutes.get('/audit/apps', async (c) => {
  const deny = (status: 401 | 403 | 429, code: string) => c.json({ error: code, code }, status);

  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return deny(401, 'missing_token');

  let claims: Awaited<ReturnType<typeof verifyGithubOidc>>;
  try {
    claims = await verifyGithubOidc(token, { audience: AUDIT_AUDIENCE });
  } catch (e) {
    const message = (e as Error).message;
    return deny(403, VERIFY_CODES.find(([re]) => re.test(message))?.[1] ?? 'invalid_token');
  }
  if (claims.repository_owner_id !== APP_ORG_ID) return deny(403, 'wrong_owner');
  if (claims.repository_id !== PLATFORM_REPO_ID) return deny(403, 'wrong_repository');
  if (claims.job_workflow_ref !== AUDIT_WORKFLOW_REF) return deny(403, 'wrong_workflow');
  if (claims.ref !== AUDIT_REF) return deny(403, 'wrong_ref');
  if (!AUDIT_EVENTS.has(claims.event_name ?? '')) return deny(403, 'wrong_event');

  // Only an authorized caller spends the budget.
  const now = Date.now();
  const recent = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM fleet_audit_reads WHERE read_at > ?',
  )
    .bind(now - 3600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= READS_PER_HOUR) return deny(429, 'rate_limited');
  await c.env.DB.prepare('INSERT INTO fleet_audit_reads (read_at) VALUES (?)').bind(now).run();
  await c.env.DB.prepare('DELETE FROM fleet_audit_reads WHERE read_at < ?')
    .bind(now - 24 * 3600_000)
    .run();

  const [apps, routes] = await Promise.all([
    c.env.DB.prepare("SELECT id, repo FROM apps WHERE store = 'apps' ORDER BY id").all<{
      id: string;
      repo: string | null;
    }>(),
    c.env.DB.prepare(
      "SELECT slug, r2_prefix FROM routes WHERE zone = 'freeappstore.online' ORDER BY slug",
    ).all<{ slug: string; r2_prefix: string }>(),
  ]);
  const prefixBySlug = new Map(routes.results.map((r) => [r.slug, r.r2_prefix]));
  const ids = new Set(apps.results.map((a) => a.id));
  return c.json({
    apps: apps.results.map((a) => ({
      id: a.id,
      repo: a.repo,
      r2Prefix: prefixBySlug.get(a.id) ?? null,
    })),
    routesWithoutApps: routes.results.map((r) => r.slug).filter((slug) => !ids.has(slug)),
  });
});
