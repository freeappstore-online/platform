/**
 * App transactional email — lets apps send email through the platform.
 *
 * POST /v1/apps/:appId/email/send
 *
 * Rate-limited per app: 100 emails/day (free tier).
 * Auth required (user must be signed in).
 * Platform owns the Resend account — apps don't need their own email provider.
 */

import { Hono } from 'hono';
import { requireUser, type CurrentUser } from '../lib/auth.js';
import { isLikelyEmail, sendEmail } from '../lib/email.js';
import { checkAndBump, d1UsageStore } from '../lib/proxy-rate-limit.js';
import type { Env } from '../types.js';

export const emailRoutes = new Hono<{ Bindings: Env }>();

const DAILY_EMAIL_LIMIT = 100;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 50_000; // 50KB

emailRoutes.post('/apps/:appId/email/send', async (c) => {
  const user = await requireUser(c);

  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) {
    return c.json({ ok: false, error: 'Email not configured (RESEND_API_KEY or EMAIL_FROM missing).' }, 503);
  }

  const appId = c.req.param('appId')!;
  const body = await c.req.json<{
    to: string;
    subject: string;
    html?: string;
    text?: string;
  }>().catch(() => null);

  if (!body) {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  // Validate recipient
  if (!body.to || !isLikelyEmail(body.to)) {
    return c.json({ ok: false, error: 'Invalid "to" email address.' }, 400);
  }

  // Validate subject
  if (!body.subject || body.subject.length > MAX_SUBJECT_LENGTH) {
    return c.json({ ok: false, error: `Subject required (max ${MAX_SUBJECT_LENGTH} chars).` }, 400);
  }

  // Validate body (at least one of html or text required)
  if (!body.html && !body.text) {
    return c.json({ ok: false, error: 'At least one of "html" or "text" is required.' }, 400);
  }
  if (body.html && body.html.length > MAX_BODY_LENGTH) {
    return c.json({ ok: false, error: `HTML body too large (max ${MAX_BODY_LENGTH} chars).` }, 413);
  }
  if (body.text && body.text.length > MAX_BODY_LENGTH) {
    return c.json({ ok: false, error: `Text body too large (max ${MAX_BODY_LENGTH} chars).` }, 413);
  }

  // Daily rate limit per app
  const usage = await checkAndBump(d1UsageStore(c.env.DB), {
    appId: `email:${appId}`,
    dailyLimit: DAILY_EMAIL_LIMIT,
    nowMs: Date.now(),
  });
  if (!usage.allowed) {
    return c.json({
      ok: false,
      error: `Daily email limit reached (${DAILY_EMAIL_LIMIT}/day per app). Resets at midnight UTC.`,
    }, 429);
  }

  try {
    await sendEmail(
      { apiKey: c.env.RESEND_API_KEY, from: c.env.EMAIL_FROM },
      {
        to: body.to,
        subject: `[${appId}] ${body.subject}`,
        html: body.html ?? `<pre>${escapeHtml(body.text!)}</pre>`,
        text: body.text ?? stripHtml(body.html!),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return c.json({ ok: false, error: `Email send failed: ${msg}` }, 502);
  }

  return c.json({ ok: true });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}
