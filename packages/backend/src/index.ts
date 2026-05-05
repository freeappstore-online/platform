import { Hono } from 'hono';
import type { Env } from './types.js';
import { authRoutes } from './routes/auth.js';
import { kvRoutes } from './routes/kv.js';
import { roomRoutes } from './routes/rooms.js';
import { uptimeRoutes } from './routes/uptime.js';
import { checkUrl, TARGETS } from './lib/uptime.js';

export { Room } from './do/room.js';

export const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('FreeAppStore API'));
app.get('/health', (c) => c.json({ ok: true }));

const v1 = new Hono<{ Bindings: Env }>();
v1.route('/', authRoutes);
v1.route('/', kvRoutes);
v1.route('/', roomRoutes);
v1.route('/', uptimeRoutes);
app.route('/v1', v1);

const HEALTH_RETENTION_DAYS = 30;

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === '*/15 * * * *') {
      // Run all health checks in parallel.
      const now = Date.now();
      const results = await Promise.all(
        TARGETS.map(async ({ id, url }) => {
          const r = await checkUrl(url);
          return { id, url, ...r, checkedAt: now };
        }),
      );

      // Bulk insert.
      const stmt = env.DB.prepare(
        `INSERT INTO health_checks (target, url, ok, status, duration_ms, error, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const batch = results.map((r) =>
        stmt.bind(r.id, r.url, r.ok ? 1 : 0, r.status, r.durationMs, r.error, r.checkedAt),
      );
      await env.DB.batch(batch);

      // Evict rows older than retention window.
      const cutoff = now - HEALTH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      await env.DB.prepare('DELETE FROM health_checks WHERE checked_at < ?').bind(cutoff).run();
    }
  },
};
