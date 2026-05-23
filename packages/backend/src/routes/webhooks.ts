/**
 * Outbound webhooks — devs register URLs to receive HTTP POST on events.
 * Vendored from PAS webhooks-config.ts, adapted for FAS auth + events.
 *
 * CRUD: /v1/apps/:appId/webhooks
 * Test: /v1/apps/:appId/webhooks/:id/test
 * Dispatch: dispatchWebhook() called by other routes when events fire
 */

import { Hono } from 'hono';
import { type CurrentUser, HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

const SUPPORTED_EVENTS = [
  'user.first_visit',
  'user.deleted',
  'kv.changed',
  'collection.created',
  'collection.deleted',
  'counter.threshold',
  'role.assigned',
  'role.revoked',
];

const MAX_WEBHOOKS_PER_APP = 5;

// ── CRUD ────────────────────────────────────────────────────────

webhookRoutes.get('/apps/:appId/webhooks', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;

  const { results } = await c.env.DB.prepare(
    'SELECT id, event, url, active, created_at FROM app_webhooks WHERE app_id = ? ORDER BY created_at DESC',
  ).bind(appId).all<{ id: string; event: string; url: string; active: number; created_at: number }>();

  return c.json({ webhooks: results, supported_events: SUPPORTED_EVENTS });
});

webhookRoutes.post('/apps/:appId/webhooks', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;

  const body = await c.req.json<{ event: string; url: string }>().catch(() => null);
  if (!body?.event || !body?.url) {
    return c.json({ ok: false, error: 'event and url required' }, 400);
  }
  if (!SUPPORTED_EVENTS.includes(body.event)) {
    return c.json({ ok: false, error: `Unsupported event. Supported: ${SUPPORTED_EVENTS.join(', ')}` }, 400);
  }

  // Validate URL
  let parsed: URL;
  try { parsed = new URL(body.url); } catch { return c.json({ ok: false, error: 'Invalid URL' }, 400); }
  if (parsed.protocol !== 'https:') return c.json({ ok: false, error: 'Webhook URL must use HTTPS' }, 400);
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') ||
      host.startsWith('10.') || host.startsWith('192.168.') || host === '169.254.169.254') {
    return c.json({ ok: false, error: 'Webhook URL must not point to private/internal addresses' }, 400);
  }

  // Cap check
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM app_webhooks WHERE app_id = ?')
    .bind(appId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_WEBHOOKS_PER_APP) {
    return c.json({ ok: false, error: `Max ${MAX_WEBHOOKS_PER_APP} webhooks per app` }, 409);
  }

  const id = crypto.randomUUID();
  const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

  await c.env.DB.prepare(
    'INSERT INTO app_webhooks (id, app_id, event, url, secret) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, appId, body.event, body.url, secret).run();

  return c.json({ id, secret });
});

webhookRoutes.delete('/apps/:appId/webhooks/:id', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  const webhookId = c.req.param('id')!;

  const result = await c.env.DB.prepare(
    'DELETE FROM app_webhooks WHERE id = ? AND app_id = ?',
  ).bind(webhookId, appId).run();

  if (!result.meta.changes) return c.json({ ok: false, error: 'Webhook not found' }, 404);
  return c.json({ ok: true });
});

// ── Test delivery ───────────────────────────────────────────────

webhookRoutes.post('/apps/:appId/webhooks/:id/test', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  const webhookId = c.req.param('id')!;

  const hook = await c.env.DB.prepare(
    'SELECT url, secret, event FROM app_webhooks WHERE id = ? AND app_id = ?',
  ).bind(webhookId, appId).first<{ url: string; secret: string; event: string }>();
  if (!hook) return c.json({ ok: false, error: 'Webhook not found' }, 404);

  const payload = { test: true, event: hook.event, appId, timestamp: Date.now() };
  const result = await deliverWebhook(hook.url, hook.secret, hook.event, payload);
  return c.json(result);
});

// ── Dispatcher (called by other routes) ─────────────────────────

export async function dispatchWebhook(
  db: D1Database,
  appId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const hooks = await db.prepare(
    'SELECT id, url, secret FROM app_webhooks WHERE app_id = ? AND event = ? AND active = 1',
  ).bind(appId, event).all<{ id: string; url: string; secret: string }>();

  for (const hook of hooks.results ?? []) {
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify({ ...payload, event, appId, timestamp: Date.now() });

    // Record the delivery attempt
    await db.prepare(
      'INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    ).bind(deliveryId, hook.id, event, body, Math.floor(Date.now() / 1000)).run();

    const result = await deliverWebhook(hook.url, hook.secret, event, JSON.parse(body));

    // Update delivery status
    await db.prepare(
      'UPDATE webhook_deliveries SET status = ?, last_attempt_at = ? WHERE id = ?',
    ).bind(result.status, Math.floor(Date.now() / 1000), deliveryId).run();
  }
}

async function deliverWebhook(
  url: string,
  secret: string,
  event: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const signature = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FAS-Signature': signature,
        'X-FAS-Event': event,
      },
      body,
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, body: text.slice(0, 1000) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'network error';
    return { status: 0, body: msg };
  }
}
