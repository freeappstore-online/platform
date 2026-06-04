import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

export const publishRoutes = new Hono<{ Bindings: Env }>();

interface PublishBody {
  name: string;
  /** "apps" only — FAS platform now serves only FreeAppStore. FGS publishes go
   *  through api.freegamestore.online (FGS admin Worker). */
  store?: 'apps';
  category: string;
  /** "standalone" | "connected" — already mapped from the CLI's verbose option strings */
  type: string;
  oneliner: string;
  description: string;
  repo: string | null;
  demo: string | null;
}

const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

const STORE_DOMAIN = {
  apps: { domain: 'freeappstore.online', org: 'freeappstore-online' },
} as const;

/**
 * Provisioning endpoint. Validates the request, then proxies to the admin
 * Worker via a service binding (env.ADMIN.fetch). Service-binding calls
 * are direct worker-to-worker — they bypass the CF edge entirely, which
 * also means CF Access doesn't run (intentional: both workers are trusted
 * internal). The admin Worker creates the GitHub repo from a template,
 * inserts the D1 hosting route and adds the entry to the storefront registry.
 *
 * Returns 503 if the ADMIN service binding isn't configured (e.g. local
 * dev without binding). Production wrangler.toml has [[services]] block.
 */
publishRoutes.post('/publish', async (c) => {
  let user;
  try {
    user = await requireUser(c);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }

  let body: PublishBody;
  try {
    body = (await c.req.json()) as PublishBody;
  } catch {
    return c.text('invalid json', 400);
  }

  if (!APP_ID_RE.test(body.name)) {
    return c.text('app name must be lowercase letters, digits, or hyphens (2-31 chars)', 400);
  }
  // FAS platform now serves only FreeAppStore. Reject games and pro stores
  // explicitly with a redirect message so callers know where to go.
  const store: 'apps' = (body.store ?? 'apps') as 'apps';
  if ((body.store as string | undefined) === 'games') {
    return c.json(
      {
        error: 'wrong_store',
        hint:
          'FGS publishes have moved to https://admin.freegamestore.online — ' +
          'run `fgs publish` (CLI auto-routes) or POST to that admin Worker directly.',
      },
      410,
    );
  }
  if (
    (body.store as string | undefined) === 'apps_pro' ||
    (body.store as string | undefined) === 'games_pro'
  ) {
    return c.json(
      {
        error: 'wrong_store',
        hint: `Pro publishes go through the per-store admin Worker (proappstore-admin / progamestore-admin), not FAS.`,
      },
      410,
    );
  }
  if (store !== 'apps') {
    return c.text('store must be "apps"', 400);
  }
  if (!body.category?.trim()) return c.text('category is required', 400);
  if (!body.oneliner?.trim()) return c.text('oneliner is required', 400);
  if (!body.description?.trim()) return c.text('description is required', 400);
  if (body.type !== 'standalone' && body.type !== 'connected') {
    return c.text('type must be "standalone" or "connected"', 400);
  }
  const meta = STORE_DOMAIN[store];

  if (!c.env.ADMIN) {
    return c.json(
      {
        error: 'admin_binding_not_configured',
        hint:
          'The ADMIN service binding is missing. Add [[services]] binding=ADMIN ' +
          'service=freeappstore-admin to wrangler.toml and redeploy.',
      },
      503,
    );
  }

  // Hand off to the admin Worker via service binding. The URL host is
  // ignored by service-binding fetch; only the path matters.
  const adminRes = await c.env.ADMIN.fetch('https://admin/api/provision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Authenticate this service-to-service call. Admin's CF Access gate can't
      // see a JWT on a service-binding request, so present the shared
      // INTERNAL_TOKEN. The end user is already authenticated above
      // (requireUser); this only proves the call originates from the backend.
      'X-Internal-Token': c.env.INTERNAL_TOKEN ?? '',
    },
    body: JSON.stringify({
      id: body.name,
      name: body.name,
      category: body.category,
      icon: '🚀',
      iconBg: '#f3f4f6',
      description: body.oneliner,
      store,
      type: body.type,
      githubLogin: user.githubLogin,
      creatorGithub: user.githubLogin,
      repo: body.repo,
      demo: body.demo,
    }),
  });

  const adminBodyText = await adminRes.text();
  if (!adminRes.ok) {
    return c.json(
      {
        error: 'admin_provision_failed',
        status: adminRes.status,
        body: adminBodyText,
      },
      502,
    );
  }

  let adminBody: unknown = adminBodyText;
  try {
    adminBody = JSON.parse(adminBodyText);
  } catch {
    // admin returned non-JSON (e.g. plain text); pass it through as-is.
  }

  // Admin's /api/provision returns 200 even when individual steps fail —
  // the response shape is { steps: [{ name, status: 'ok'|'skip'|'fail',
  // detail }] }. A 200 with any step failed is a partial provisioning;
  // surface that as 502 so the CLI can fall back to the Issue form.
  const failedSteps = extractFailedSteps(adminBody);
  if (failedSteps.length > 0) {
    return c.json(
      {
        error: 'admin_provision_partial_failure',
        failedSteps,
        admin: adminBody,
      },
      502,
    );
  }

  // Record this app/game as owned by the user so `fas list` / GET /v1/apps/mine
  // can return it. INSERT OR IGNORE because retries of a successful publish
  // shouldn't fail — the admin worker is idempotent on the registry side.
  // The store column lets us tell apps and games apart in `fas list`.
  try {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO apps
       (id, owner_login, created_at, category, type, oneliner, repo, demo, store)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        body.name,
        user.githubLogin,
        Date.now(),
        body.category,
        body.type,
        body.oneliner,
        body.repo,
        body.demo,
        store,
      )
      .run();
  } catch (err) {
    // Ownership-record failure should not undo a successful provision —
    // the storefront registry is the canonical record. Log + continue.
    console.error('failed to record app ownership', err);
  }

  return c.json({
    appId: body.name,
    store,
    appUrl: `https://${body.name}.${meta.domain}`,
    repoUrl: `https://github.com/${meta.org}/${body.name}`,
    admin: adminBody,
  });
});

interface AdminStep {
  name: string;
  status: 'ok' | 'skip' | 'fail';
  detail?: string;
}

export function extractFailedSteps(body: unknown): AdminStep[] {
  if (!body || typeof body !== 'object') return [];
  const steps = (body as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const failed: AdminStep[] = [];
  for (const s of steps) {
    if (s && typeof s === 'object' && (s as { status?: unknown }).status === 'fail') {
      failed.push(s as AdminStep);
    }
  }
  return failed;
}

/**
 * Internal endpoint for cross-store app registration. PAS calls this
 * during provision so Pro apps appear in the FAS `apps` table, which
 * is required for proxy, secrets, and allowlist features to work.
 *
 * Auth: X-Internal-Token header (shared secret between FAS + PAS).
 */
publishRoutes.post('/internal/register-app', async (c) => {
  const provided = c.req.header('X-Internal-Token');
  const expected = (c.env as Env & { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  if (!expected || provided !== expected) return c.text('forbidden', 403);

  const body = await c.req
    .json<{ appId?: string; ownerLogin?: string }>()
    .catch(() => ({}) as { appId?: string; ownerLogin?: string });
  if (!body.appId || !body.ownerLogin) return c.text('appId and ownerLogin required', 400);
  if (!/^[a-z][a-z0-9-]*$/.test(body.appId) || body.appId.length > 58) {
    return c.text('invalid appId', 400);
  }

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO apps (id, owner_login, created_at, store)
     VALUES (?, ?, ?, 'apps_pro')`,
  )
    .bind(body.appId, body.ownerLogin, Date.now())
    .run();

  return c.json({ ok: true, appId: body.appId });
});
