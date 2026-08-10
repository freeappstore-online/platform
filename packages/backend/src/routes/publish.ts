import { Hono } from 'hono';
import { APP_ID_RE } from '../lib/apps.js';
import { HttpError, isAdminLogin, requireUser } from '../lib/auth.js';
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
  /**
   * Attribute the app to a different creator than the publisher — for onboarding
   * a contributor's app on their behalf. Admin-only (a regular publisher is
   * always recorded as the creator, so nobody can spoof credit). Defaults to the
   * publisher's login.
   */
  creatorGithub?: string;
}

// GitHub username rules: 1–39 chars, alphanumeric or single hyphens (not
// leading/trailing/doubled).
const GITHUB_LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

const VALID_CATEGORIES = [
  'Learning',
  'Strategy',
  'Discovery',
  'Brain Training',
  'Social',
  'Productivity',
  'Lifestyle',
  'Health & Fitness',
  'Finance',
  'Creative',
  'News & Weather',
  'Utilities',
  'Other (specify in description)',
] as const;

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
  const catNorm = body.category.trim();
  const validCat = VALID_CATEGORIES.find((c) => c.toLowerCase() === catNorm.toLowerCase());
  if (!validCat)
    return c.text(
      `invalid category: ${catNorm}. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
      400,
    );
  body.category = validCat;
  if (!body.oneliner?.trim()) return c.text('oneliner is required', 400);
  if (!body.description?.trim()) return c.text('description is required', 400);
  if (body.type !== 'standalone' && body.type !== 'connected') {
    return c.text('type must be "standalone" or "connected"', 400);
  }
  const meta = STORE_DOMAIN[store];

  // Resolve the creator. Defaults to the publisher; only an admin may attribute
  // an app to a different user (contributor onboarding), so a regular publisher
  // can't spoof credit to (or blame) someone else.
  let creatorGithub = user.githubLogin;
  if (body.creatorGithub && body.creatorGithub !== user.githubLogin) {
    if (!isAdminLogin(user.githubLogin, c.env)) {
      return c.text('only admins may set creatorGithub for another user', 403);
    }
    if (!GITHUB_LOGIN_RE.test(body.creatorGithub)) {
      return c.text('invalid creatorGithub', 400);
    }
    creatorGithub = body.creatorGithub;
  }

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
      // ADMIN_PROVISION_TOKEN. The end user is already authenticated above
      // (requireUser); this only proves the call originates from the backend.
      'X-Internal-Token': c.env.ADMIN_PROVISION_TOKEN ?? '',
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
      githubLogin: creatorGithub,
      creatorGithub,
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

  // Ownership is recorded by the admin worker, which writes the `apps` row in
  // the SAME D1 batch as the `routes` row (see insertHostRoute). We deliberately
  // do NOT insert here: this wrapper and the admin worker used to write
  // overlapping state to the shared `fas` DB from two places, and the
  // best-effort try/catch here silently dropped 21 apps' ownership rows when it
  // failed. The backend is now a pure auth/validation proxy — it resolves
  // `creatorGithub` (admin-gated) and forwards it; the admin worker is the
  // single writer of both the route and the ownership row, atomically.
  return c.json({
    appId: body.name,
    store,
    appUrl: `https://${body.name}.${meta.domain}`,
    repoUrl: `https://github.com/${meta.org}/${body.name}`,
    admin: adminBody,
  });
});

interface UnpublishBody {
  id: string;
  /** "apps" only — FAS serves FreeAppStore. */
  store?: 'apps';
  /** When true, also delete the GitHub repo (not just archive/delist). */
  deleteRepo?: boolean;
}

/**
 * Unpublish (deprovision) an app. Symmetric with `/publish`: session-gated on
 * the public API, then forwarded to the CF-Access-gated admin Worker via the
 * ADMIN service binding (which bypasses the edge, so Access doesn't run). This
 * lets the app owner — or an admin — tear down an app through the same trusted
 * path publish uses, without exposing admin.freeappstore.online to CI or
 * creators directly. Admin's `/api/deprovision` removes the registry entry,
 * D1 route, R2 objects and DNS (+ the repo when deleteRepo is set).
 */
publishRoutes.post('/unpublish', async (c) => {
  let user;
  try {
    user = await requireUser(c);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }

  let body: UnpublishBody;
  try {
    body = (await c.req.json()) as UnpublishBody;
  } catch {
    return c.text('invalid json', 400);
  }

  if (!body.id || !APP_ID_RE.test(body.id)) {
    return c.text('valid app id required', 400);
  }
  const store: 'apps' = (body.store ?? 'apps') as 'apps';
  if (store !== 'apps') return c.text('store must be "apps"', 400);

  // Ownership gate: only the app's owner or a platform admin may unpublish.
  const row = await c.env.DB.prepare('SELECT owner_login FROM apps WHERE id = ? AND store = ?')
    .bind(body.id, store)
    .first<{ owner_login: string }>();
  if (!row) return c.json({ error: 'not_found', appId: body.id }, 404);
  const isOwner = row.owner_login?.toLowerCase() === user.githubLogin.toLowerCase();
  if (!isOwner && !isAdminLogin(user.githubLogin, c.env)) {
    return c.text('only the app owner or an admin may unpublish', 403);
  }

  if (!c.env.ADMIN) {
    return c.json({ error: 'admin_binding_not_configured' }, 503);
  }

  const adminRes = await c.env.ADMIN.fetch('https://admin/api/deprovision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': c.env.ADMIN_PROVISION_TOKEN ?? '',
    },
    body: JSON.stringify({ id: body.id, store, deleteRepo: body.deleteRepo === true }),
  });

  const adminText = await adminRes.text();
  let adminBody: unknown = adminText;
  try {
    adminBody = JSON.parse(adminText);
  } catch {
    // non-JSON passthrough
  }
  if (!adminRes.ok) {
    return c.json(
      { error: 'admin_deprovision_failed', status: adminRes.status, admin: adminBody },
      502,
    );
  }

  return c.json({ appId: body.id, store, admin: adminBody });
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
 * Auth: X-Internal-Token header — CROSS_STORE_REGISTER_TOKEN, a dedicated
 * FAS↔PAS secret distinct from the backend↔admin provisioning token.
 */
publishRoutes.post('/internal/register-app', async (c) => {
  const provided = c.req.header('X-Internal-Token');
  const expected = c.env.CROSS_STORE_REGISTER_TOKEN;
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
