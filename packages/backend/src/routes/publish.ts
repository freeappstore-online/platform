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
 * Worker (admin.freeappstore.online/api/provision) via a CF Access service
 * token. The admin Worker creates the GitHub repo from a template, sets up
 * the CF Pages project, DNS record, custom domain, and adds the entry to
 * the storefront registry.
 *
 * Returns 503 with a setup hint if the admin service-token bindings aren't
 * configured yet — that's a one-time admin task in the CF dashboard.
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

  // Configuration check: the admin Worker is gated by Cloudflare Access.
  // To call it from a Worker, we need a CF Access service token, which is
  // a one-time admin step. Until those are set, return a clear hint.
  const adminBase = c.env.ADMIN_API_BASE;
  const accessId = c.env.ADMIN_CF_ACCESS_CLIENT_ID;
  const accessSecret = c.env.ADMIN_CF_ACCESS_CLIENT_SECRET;
  if (!adminBase || !accessId || !accessSecret) {
    return c.json(
      {
        error: 'admin_provision_not_configured',
        hint:
          'Set ADMIN_API_BASE, ADMIN_CF_ACCESS_CLIENT_ID, ADMIN_CF_ACCESS_CLIENT_SECRET via ' +
          '`wrangler secret put`. The service token is created in CF dashboard → Zero Trust → ' +
          'Access → Service Auth → Service Tokens. Then update the admin app policy to allow it.',
      },
      503,
    );
  }

  // Hand off to the admin Worker. We pass the requester's GitHub login so
  // admin can grant push access on the new repo to the right user.
  const adminRes = await fetch(`${adminBase.replace(/\/$/, '')}/api/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Access-Client-Id': accessId,
      'CF-Access-Client-Secret': accessSecret,
    },
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
