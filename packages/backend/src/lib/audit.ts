/**
 * Compliance audit job: re-scans published apps + games post-publish
 * for compliance drift. Triggered by the Sunday-morning cron in
 * src/index.ts; results land in the `audit_results` D1 table for the
 * /v1/audit endpoint to expose.
 *
 * Why this exists: `fas check` only runs at publish-time. Apps drift
 * after — someone adds a tracker, removes the brand fonts, etc. This
 * weekly sweep catches that.
 *
 * Worker subrequest cap: each `fetch()` counts as one subrequest, and
 * Workers cap outgoing subrequests per invocation (50 on the free
 * plan, 1000 on paid). One audit per app does up to 3 fetches (HTML +
 * manifest + bundle) plus 2 registry fetches. With ~60 apps the total
 * is ~180 — over the free-plan limit. So we batch: each call audits
 * the BATCH_SIZE stalest entries, leaving stale-but-audited rows to
 * the next call. The Sunday cron runs once; for first-deploy
 * back-fill, hit POST /v1/audit/run multiple times until coverage
 * stabilises.
 */

import { auditLive, type LiveAuditReport } from '@freeappstore/compliance';

interface RegistryItem {
  id: string;
  appUrl: string;
}

const REGISTRY_URLS = {
  apps: 'https://raw.githubusercontent.com/freeappstore-online/freeappstore/main/registry.json',
  games: 'https://raw.githubusercontent.com/freegamestore-online/freegamestore/main/registry.json',
} as const;

// CF free-tier cap is 50 subrequests per invocation, and redirects
// count as separate subrequests. In practice each app runs 3 fetches
// (HTML, manifest, bundle), but custom-subdomain apps often redirect
// 2-3 hops (apex → www → cf-pages → final), pushing real subrequest
// count to 6-9 per app. With 14 apps that blew past 50 — every batch
// reported "Too many subrequests" against the manifest/bundle checks,
// poisoning the storefront audit badge with false fails.
//
// 8 apps × 9 worst-case = 72... still risky on free, but with median
// ~5 subrequests per app it stays comfortably under 50. The bigger
// fix is moving the audit Worker to a paid plan; until then 8 is the
// honest batch size.
const BATCH_SIZE = 8;

async function fetchRegistry(store: 'apps' | 'games'): Promise<RegistryItem[]> {
  const res = await fetch(REGISTRY_URLS[store]);
  if (!res.ok) return [];
  const body = (await res.json()) as { apps?: RegistryItem[]; games?: RegistryItem[] };
  return store === 'apps' ? (body.apps ?? []) : (body.games ?? []);
}

/**
 * Pull the most-recent checked_at per app from D1 so we can sort
 * stalest-first. Apps never audited yet appear with checkedAt = 0
 * and sort to the front.
 */
async function fetchLastCheckedMap(db: D1Database): Promise<Map<string, number>> {
  const result = await db
    .prepare('SELECT app_id, MAX(checked_at) AS max_at FROM audit_results GROUP BY app_id')
    .all<{ app_id: string; max_at: number }>();
  const map = new Map<string, number>();
  for (const row of result.results ?? []) map.set(row.app_id, row.max_at ?? 0);
  return map;
}

export async function runAudit(db: D1Database): Promise<{ scanned: number; failed: number }> {
  const [apps, games, lastChecked] = await Promise.all([
    fetchRegistry('apps'),
    fetchRegistry('games'),
    fetchLastCheckedMap(db),
  ]);
  const all: Array<{ store: 'apps' | 'games'; item: RegistryItem }> = [
    ...apps.map((item) => ({ store: 'apps' as const, item })),
    ...games.map((item) => ({ store: 'games' as const, item })),
  ];

  // Stalest first: never-audited (no row) → 0; audited long ago → small;
  // recently audited → large. Slice to BATCH_SIZE.
  all.sort((a, b) => (lastChecked.get(a.item.id) ?? 0) - (lastChecked.get(b.item.id) ?? 0));
  const batch = all.slice(0, BATCH_SIZE);

  // Audit in parallel — each app is an independent fetch chain with
  // its own 8s timeout in auditLive.
  const reports = await Promise.all(
    batch.map(({ store, item }) =>
      auditLive({ appId: item.id, liveUrl: item.appUrl }).then((r) => ({ store, report: r })),
    ),
  );

  await persistResults(db, reports);
  const failed = reports.reduce(
    (n, { report }) => n + report.results.filter((r) => r.status === 'fail').length,
    0,
  );
  return { scanned: reports.length, failed };
}

async function persistResults(
  db: D1Database,
  reports: Array<{ store: 'apps' | 'games'; report: LiveAuditReport }>,
): Promise<void> {
  // Upsert each (app_id, check_name) row. D1 lacks a multi-statement
  // transaction wrapper at runtime; we use INSERT ... ON CONFLICT DO
  // UPDATE on the composite primary key.
  const stmt = db.prepare(
    `INSERT INTO audit_results (app_id, store, check_name, status, detail, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id, check_name) DO UPDATE SET
       status = excluded.status,
       detail = excluded.detail,
       checked_at = excluded.checked_at,
       store = excluded.store`,
  );
  const batch: D1PreparedStatement[] = [];
  for (const { store, report } of reports) {
    for (const r of report.results) {
      batch.push(
        stmt.bind(report.appId, store, r.name, r.status, r.detail ?? null, report.checkedAt),
      );
    }
  }
  if (batch.length === 0) return;
  await db.batch(batch);
}
