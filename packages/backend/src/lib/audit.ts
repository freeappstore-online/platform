/**
 * Compliance audit job: re-scans every published app + game post-publish
 * for compliance drift. Triggered by the Sunday-morning cron in
 * src/index.ts; results land in the `audit_results` D1 table for the
 * /v1/audit endpoint to expose.
 *
 * Why this exists: `fas check` only runs at publish-time. Apps drift
 * after — someone adds a tracker, removes the brand fonts, etc. This
 * weekly sweep catches that within ~7 days.
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

async function fetchRegistry(store: 'apps' | 'games'): Promise<RegistryItem[]> {
  const res = await fetch(REGISTRY_URLS[store]);
  if (!res.ok) return [];
  const body = (await res.json()) as { apps?: RegistryItem[]; games?: RegistryItem[] };
  return store === 'apps' ? body.apps ?? [] : body.games ?? [];
}

export async function runAudit(db: D1Database): Promise<{ scanned: number; failed: number }> {
  const [apps, games] = await Promise.all([fetchRegistry('apps'), fetchRegistry('games')]);
  const items: Array<{ store: 'apps' | 'games'; item: RegistryItem }> = [
    ...apps.map((item) => ({ store: 'apps' as const, item })),
    ...games.map((item) => ({ store: 'games' as const, item })),
  ];

  // Audit in parallel — each app is an independent fetch chain that
  // respects its own 8s timeout in auditLive. With ~50 apps total we
  // finish well under the 30s Workers cron CPU budget.
  const reports = await Promise.all(
    items.map(({ store, item }) =>
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
