/**
 * App transactional email — lets apps send email through the platform.
 *
 * POST /v1/apps/:appId/email/send
 *
 * Rate-limited per app: 100 emails/day (free tier), plus a platform-wide cap.
 * Auth required (user must be signed in). The app owner may send to anyone;
 * any other user must hold a role in the app and may only send to their own
 * verified address (#487) — otherwise every session is an open relay from the
 * platform's verified sending domain.
 * Platform owns the Cloudflare Email Service binding — apps do not need their
 * own email provider.
 */

import { Hono } from 'hono';
import { APP_ID_RE } from '../lib/apps.js';
import { isAppOwner, requireAppUser } from '../lib/auth.js';
import { escapeHtml, isLikelyEmail, sendEmail } from '../lib/email.js';
import { checkAndBump, d1UsageStore } from '../lib/proxy-rate-limit.js';
import type { Env } from '../types.js';

export const emailRoutes = new Hono<{ Bindings: Env }>();

const DAILY_EMAIL_LIMIT = 100;
const DAILY_EMAIL_LIMIT_PER_USER = 50;
/** Hard ceiling across every app and user, so N accounts × M apps can't scale the relay. */
export const DAILY_EMAIL_LIMIT_PLATFORM = 2000;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 50_000; // 50KB

emailRoutes.post('/apps/:appId/email/send', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));

  if (!c.env.EMAIL) return c.json({ ok: false, error: 'Email not configured.' }, 503);

  const appId = c.req.param('appId')!;
  // Require a real app — otherwise the per-app quota is trivially reset by
  // rotating the id, turning this into an unbounded relay from the platform's
  // verified sending domain.
  const appRow = APP_ID_RE.test(appId)
    ? await c.env.DB.prepare('SELECT owner_login FROM apps WHERE id = ?')
        .bind(appId)
        .first<{ owner_login: string | null }>()
    : null;
  if (!appRow) {
    return c.json({ ok: false, error: 'unknown app' }, 404);
  }
  const body = await c.req
    .json<{
      to: string;
      subject: string;
      html?: string;
      text?: string;
    }>()
    .catch(() => null);

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
  if (
    (body.html !== undefined && typeof body.html !== 'string') ||
    (body.text !== undefined && typeof body.text !== 'string')
  ) {
    return c.json({ ok: false, error: '"html" and "text" must be strings.' }, 400);
  }
  if (!body.html && !body.text) {
    return c.json({ ok: false, error: 'At least one of "html" or "text" is required.' }, 400);
  }
  if (body.html && body.html.length > MAX_BODY_LENGTH) {
    return c.json({ ok: false, error: `HTML body too large (max ${MAX_BODY_LENGTH} chars).` }, 413);
  }
  if (body.text && body.text.length > MAX_BODY_LENGTH) {
    return c.json({ ok: false, error: `Text body too large (max ${MAX_BODY_LENGTH} chars).` }, 413);
  }

  // Who may send what: the owner sends on behalf of their app to anyone
  // (the fas.email.send() contract). Anyone else needs a role in the app
  // and may only mail their own verified address, so a signed-in stranger
  // can't send arbitrary HTML to arbitrary people under our domain.
  const owner = isAppOwner(user, appRow.owner_login);
  if (!owner) {
    const role = await c.env.DB.prepare(
      'SELECT 1 FROM app_roles WHERE app_id = ? AND user_id = ? LIMIT 1',
    )
      .bind(appId, user.id)
      .first();
    if (!role) return c.json({ ok: false, error: 'not a member of this app' }, 403);
    const me = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ email: string | null }>();
    if (!me?.email || me.email.toLowerCase() !== body.to.toLowerCase()) {
      return c.json({ ok: false, error: 'Only the app owner may email other recipients.' }, 403);
    }
  }

  // Exact counts (denominator 1): these are hard caps on a relay from the
  // platform's sending domain, not the proxy's soft budget. Check the user
  // first so a user already over their limit can't drain the app's quota.
  const now = Date.now();
  const userUsage = await checkAndBump(d1UsageStore(c.env.DB), {
    appId: `email-user:${user.id}`,
    dailyLimit: DAILY_EMAIL_LIMIT_PER_USER,
    nowMs: now,
    denominator: 1,
  });
  if (!userUsage.allowed) {
    return c.json(
      {
        ok: false,
        error: `Daily email limit reached (${DAILY_EMAIL_LIMIT_PER_USER}/day per user). Resets at midnight UTC.`,
      },
      429,
    );
  }
  // …and per app, so the per-user cap can't be multiplied by many accounts.
  const usage = await checkAndBump(d1UsageStore(c.env.DB), {
    appId: `email:${appId}`,
    dailyLimit: DAILY_EMAIL_LIMIT,
    nowMs: now,
    denominator: 1,
  });
  if (!usage.allowed) {
    return c.json(
      {
        ok: false,
        error: `Daily email limit reached (${DAILY_EMAIL_LIMIT}/day per app). Resets at midnight UTC.`,
      },
      429,
    );
  }
  // …and platform-wide, the ceiling on what the sending domain emits per day.
  const platformUsage = await checkAndBump(d1UsageStore(c.env.DB), {
    appId: 'email-platform',
    dailyLimit: DAILY_EMAIL_LIMIT_PLATFORM,
    nowMs: now,
    denominator: 1,
  });
  if (!platformUsage.allowed) {
    return c.json(
      { ok: false, error: 'Platform daily email limit reached. Resets at midnight UTC.' },
      429,
    );
  }

  try {
    await sendEmail(c.env.EMAIL, {
      to: body.to,
      subject: `[${appId}] ${body.subject}`,
      sender: 'noreply',
      replyTo: 'support@freeappstore.online',
      html: body.html ?? `<pre>${escapeHtml(body.text!)}</pre>`,
      text: body.text ?? stripHtml(body.html!),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error('App email send failed', { appId, userId: user.id, error: msg });
    return c.json({ ok: false, error: 'Email send failed.' }, 502);
  }
  console.log('app_email_sent', { appId, userId: user.id, owner });

  return c.json({ ok: true });
});

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
