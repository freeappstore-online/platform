import { Hono } from 'hono';
import type { Env } from '../types.js';

export const qualityRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /apps/:id/quality — returns the VCQA code health report JSON for
 * an app. Reports are uploaded by the deploy workflow to R2 at
 * `apps/{id}/.vcqa/report.json`. No auth required; quality scores are public.
 */
qualityRoutes.get('/apps/:id/quality', async (c) => {
  const bucket = c.env.APPS_BUCKET;
  if (!bucket) {
    return c.json({ error: 'Quality reports not available (storage not configured)' }, 503);
  }

  const appId = c.req.param('id');
  const key = `apps/${appId}/.vcqa/report.json`;
  const obj = await bucket.get(key);

  if (!obj) {
    return c.json({ error: 'No quality report found for this app' }, 404);
  }

  const report = await obj.json();
  return c.json(report);
});

/**
 * GET /apps/:id/quality/badge — returns the VCQA badge SVG for an app.
 * Useful for embedding in READMEs or dashboards. Returns SVG with the
 * correct content-type. No auth required.
 */
qualityRoutes.get('/apps/:id/quality/badge', async (c) => {
  const bucket = c.env.APPS_BUCKET;
  if (!bucket) {
    return c.json({ error: 'Quality badges not available (storage not configured)' }, 503);
  }

  const appId = c.req.param('id');
  const key = `apps/${appId}/.vcqa/badge.svg`;
  const obj = await bucket.get(key);

  if (!obj) {
    return c.json({ error: 'No quality badge found for this app' }, 404);
  }

  const svg = await obj.text();
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=300',
  });
});
