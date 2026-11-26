import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fetchRegistry, runAudit } from './lib/audit.js';
import { HttpError, hasInternalToken } from './lib/auth.js';
import { backupD1ToR2 } from './lib/backup.js';
import { pruneNativeData } from './lib/native-companion.js';
import { isAllowedOrigin } from './lib/origins.js';
import { pruneUsage } from './lib/proxy-rate-limit.js';
import { runPushDelivery } from './lib/push-delivery.js';
import { publicStatusReport, runStatusChecks } from './lib/status.js';
import { burstCheck, burstSample, checkUrl, TARGETS } from './lib/uptime.js';
import { agentSessionRoutes } from './routes/agent-sessions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { appsRoutes } from './routes/apps.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { contentAdminRoutes } from './routes/content-admin.js';
import { counterRoutes } from './routes/counters.js';
import { dataRoomRoutes } from './routes/data-rooms.js';
import { dbRoutes } from './routes/db.js';
import { deployRoutes, pruneDeploys } from './routes/deploy.js';
import { emailRoutes } from './routes/email.js';
import { exchangeRoutes } from './routes/exchange.js';
import { fleetAuditRoutes } from './routes/fleet-audit.js';
import { friendsRoutes } from './routes/friends.js';
import { generationRoutes, pruneGenerated, verifyPending } from './routes/generation.js';
import { ideaBuildersRoutes } from './routes/idea-builders.js';
import { keysRoutes } from './routes/keys.js';
import { kvRoutes } from './routes/kv.js';
import { logsRoutes } from './routes/logs.js';
import { nativeRoutes } from './routes/native.js';
import { nativeAuthRoutes } from './routes/native-auth.js';
import { photoRoutes, prunePhotos } from './routes/photos.js';
import { publishRoutes } from './routes/publish.js';
import { pushRoutes } from './routes/push.js';
import { qualityRoutes } from './routes/quality.js';
import { rolesRoutes } from './routes/roles.js';
import { roomRoutes } from './routes/rooms.js';
import { secretsRoutes } from './routes/secrets.js';
import { uptimeRoutes } from './routes/uptime.js';
import { votesRoutes } from './routes/votes.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { Env } from './types.js';

export { Room } from './do/room.js';

export const app = new Hono<{ Bindings: Env }>();

// CORS for cross-origin browser fetches into the API. Without this, any
// route called via fetch() with an Authorization header (auth/me, kv) fails
// the preflight from a non-API origin. WebSockets are exempt from CORS so
// rooms aren't affected, but the SDK calls /v1/auth/me first during init()
// and a CORS failure there breaks the rest of the SDK.
// The magic-link start sets a browser-binding cookie (#514), so it alone
// accepts credentialed requests. It answers its own preflight before the
// global middleware below would. Nothing else on the API reads cookies.
app.use(
  '/v1/auth/email/start',
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: true,
    maxAge: 600,
  }),
);
app.use(
  '*',
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Lease-Token / X-Attestation: community generation uploads (#728).
    allowHeaders: ['Authorization', 'Content-Type', 'X-Lease-Token', 'X-Attestation'],
    maxAge: 600,
  }),
);

// Security headers on every response.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  // A page that sets its own (the magic-link confirmation, #514) keeps it.
  if (!c.res.headers.has('Referrer-Policy')) {
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // The API serves data, not documents: a response opened as a page can run
  // nothing and be framed by nothing (#495). The two documents it does serve —
  // the /v1/keys page and quality badge SVGs — set their own policy.
  if (!c.res.headers.has('Content-Security-Policy')) {
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
});

// Global error handler: convert HttpError to proper HTTP responses
// instead of letting them become 500s.
app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 401);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.get('/', (c) => c.text('FreeAppStore API'));
app.get('/health', (c) => c.json({ ok: true }));

// Status page: actively probes downstream dependencies (DB, backend→admin
// provisioning auth). Public so a scheduled probe and the post-deploy smoke can
// read it, but without the per-check detail (which names missing secrets) and
// cached; the internal token gets the live detail (#470). Returns 503 when any
// critical probe is red.
app.get('/status', async (c) => {
  const report = hasInternalToken(c)
    ? await runStatusChecks(c.env)
    : await publicStatusReport(c.env);
  return c.json(report, report.status === 'ok' ? 200 : 503);
});

const v1 = new Hono<{ Bindings: Env }>();
v1.route('/', authRoutes);
v1.route('/', exchangeRoutes);
v1.route('/', kvRoutes);
v1.route('/', roomRoutes);
v1.route('/', uptimeRoutes);
v1.route('/', publishRoutes);
v1.route('/', appsRoutes);
v1.route('/', analyticsRoutes);
v1.route('/', auditRoutes);
v1.route('/', secretsRoutes);
v1.route('/', counterRoutes);
v1.route('/', dbRoutes);
v1.route('/', dataRoomRoutes);
v1.route('/', rolesRoutes);
v1.route('/', keysRoutes);
v1.route('/', emailRoutes);
v1.route('/', logsRoutes);
v1.route('/', webhookRoutes);
v1.route('/', friendsRoutes);
v1.route('/', contentAdminRoutes);
v1.route('/', agentSessionRoutes);
v1.route('/', deployRoutes);
v1.route('/', fleetAuditRoutes);
v1.route('/', qualityRoutes);
v1.route('/', votesRoutes);
v1.route('/', ideaBuildersRoutes);
v1.route('/', pushRoutes);
v1.route('/', photoRoutes);
v1.route('/', generationRoutes);
v1.route('/', nativeAuthRoutes);
v1.route('/', nativeRoutes);
app.route('/v1', v1);

const HEALTH_RETENTION_DAYS = 30;

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === '*/15 * * * *') {
      // Independent jobs: a failing uptime probe mustn't hold back reminders.
      const jobs = await Promise.allSettled([
        runUptimeChecks(env),
        runPushDelivery(env),
        prunePhotos(env),
        pruneGenerated(env),
        verifyPending(env),
        pruneNativeData(env.DB, Date.now()),
      ]);
      for (const job of jobs)
        if (job.status === 'rejected') console.error('cron */15:', job.reason);
    } else if (event.cron === '0 4 * * *') {
      await runDailyBackup(env);
    } else if (event.cron === '0 3 * * *') {
      // Independent prunes: one failing must not skip the others, notably the
      // auth_codes prune, whose rows still hold live session material (#677).
      const now = Date.now();
      const nowEpoch = Math.floor(now / 1000);
      const cutoff = now - 7 * 24 * 60 * 60 * 1000;
      const jobs = await Promise.allSettled([
        // Abandoned and superseded keyless-deploy releases (#460).
        pruneDeploys(env, undefined, 25),
        // Daily log cleanup — prune entries older than 7 days.
        env.DB.prepare('DELETE FROM app_logs WHERE ingested_at < ?')
          .bind(cutoff)
          .run()
          .then((result) =>
            console.log(
              `log-prune: deleted=${result.meta?.changes ?? 0} (cutoff=${new Date(cutoff).toISOString()})`,
            ),
          ),
        pruneUsage(env.DB, now),
        // Expired magic-link tokens (replay prevention table).
        env.DB.prepare('DELETE FROM consumed_tokens WHERE expires_at < ?').bind(nowEpoch).run(),
        // Expired one-time auth codes. Redemption deletes them, so these are
        // the abandoned flows — rows here still hold a live session token.
        env.DB.prepare('DELETE FROM auth_codes WHERE expires_at < ?').bind(nowEpoch).run(),
        // Webhook delivery records (payload holds user ids) older than 7 days (#764).
        env.DB.prepare('DELETE FROM webhook_deliveries WHERE created_at < ?')
          .bind(nowEpoch - 7 * 24 * 60 * 60)
          .run(),
      ]);
      for (const job of jobs) if (job.status === 'rejected') console.error('cron 0 3:', job.reason);
    } else if (event.cron === '0 6 * * SUN') {
      // Weekly compliance audit — Sunday 06:00 UTC. Logs the totals
      // so a missed audit is obvious in `wrangler tail`.
      const r = await runAudit(env.DB);
      console.log(`audit: scanned=${r.scanned} failures=${r.failed}`);
    }
  },
};

async function runUptimeChecks(env: Env): Promise<void> {
  const now = Date.now();
  const results = await Promise.all(
    TARGETS.map(async ({ id, url }) => {
      const r = await checkUrl(url);
      return { id, url, ...r, checkedAt: now };
    }),
  );

  // Concurrent bursts (#642), one app at a time so each burst's requests overlap.
  const ids = await fetchRegistry('apps')
    .then((apps) => apps.map((a) => a.id))
    .catch(() => [] as string[]);
  for (const app of burstSample(ids, Math.floor(now / (15 * 60_000)))) {
    const url = `https://${app}.freeappstore.online/`;
    results.push({ id: `burst:${app}`, url, ...(await burstCheck(url)), checkedAt: now });
  }

  const stmt = env.DB.prepare(
    `INSERT INTO health_checks (target, url, ok, status, duration_ms, error, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = results.map((r) =>
    stmt.bind(r.id, r.url, r.ok ? 1 : 0, r.status, r.durationMs, r.error, r.checkedAt),
  );
  await env.DB.batch(batch);

  const cutoff = now - HEALTH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await env.DB.prepare('DELETE FROM health_checks WHERE checked_at < ?').bind(cutoff).run();
}

async function runDailyBackup(env: Env): Promise<void> {
  if (!env.BACKUPS) {
    // R2 binding not configured. The audit DR.md flags this as a gap;
    // wire BACKUPS in wrangler.toml once R2 is enabled on the account.
    console.log('skipping daily backup: BACKUPS binding not configured');
    return;
  }
  const result = await backupD1ToR2(env.DB, env.BACKUPS);
  console.log('backup written', result);
}
