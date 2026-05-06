import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

export const publishRoutes = new Hono<{ Bindings: Env }>();

interface PublishBody {
  name: string;
  category: string;
  /** "standalone" | "connected" — already mapped from the CLI's verbose option strings */
  type: string;
  oneliner: string;
  description: string;
  repo: string | null;
  demo: string | null;
}

const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Provisioning endpoint. Validates the request, then proxies to the admin
 * Worker via a service binding (env.ADMIN.fetch). Service-binding calls
 * are direct worker-to-worker — they bypass the CF edge entirely, which
 * also means CF Access doesn't run (intentional: both workers are trusted
 * internal). The admin Worker creates the GitHub repo from a template,
 * sets up the CF Pages project, DNS record, custom domain, and adds the
 * entry to the storefront registry.
 *
 * Returns 503 if the ADMIN service binding isn't configured (e.g. local
 * dev without binding). Production wrangler.toml has [[services]] block.
 */
publishRoutes.post('/publish', async (c) => {
  let user;
  try {
    user = await requireUser(c);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
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
  if (!body.category?.trim()) return c.text('category is required', 400);
  if (!body.oneliner?.trim()) return c.text('oneliner is required', 400);
  if (!body.description?.trim()) return c.text('description is required', 400);
  if (body.type !== 'standalone' && body.type !== 'connected') {
    return c.text('type must be "standalone" or "connected"', 400);
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: body.name,
      name: body.name,
      category: body.category,
      icon: '🚀',
      iconBg: '#f3f4f6',
      description: body.oneliner,
      store: 'apps',
      type: body.type,
      githubLogin: user.login,
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

  return c.json({
    appId: body.name,
    appUrl: `https://${body.name}.freeappstore.online`,
    repoUrl: `https://github.com/freeappstore-online/${body.name}`,
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
