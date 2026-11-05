import { describe, expect, it } from 'vitest';
import { hasSqlite, sqliteD1 } from './sqlite-d1.testutil.js';

/**
 * #442: owner lookups compare `COLLATE NOCASE`, which the BINARY
 * apps_owner_idx (0003) can't serve. 0031 adds a NOCASE index; these are the
 * exact predicates routes/auth.ts (computeRoles), routes/apps.ts (/apps/mine,
 * /apps/deploy-status) and routes/analytics.ts (/analytics/summary) issue.
 */
const OWNER_QUERIES = [
  'SELECT id FROM apps WHERE owner_login = ? COLLATE NOCASE',
  'SELECT id, owner_login, created_at, category, type, oneliner, repo, demo, store FROM apps WHERE owner_login = ? COLLATE NOCASE ORDER BY created_at DESC',
];

describe.skipIf(!hasSqlite)('apps_owner_nocase_idx', () => {
  it.each(OWNER_QUERIES)('serves `%s` from the NOCASE index, not a table scan', (sql) => {
    const { db } = sqliteD1();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('alice') as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join('\n');
    expect(details).toMatch(/SEARCH apps USING (COVERING )?INDEX apps_owner_nocase_idx/);
    expect(details).not.toMatch(/SCAN apps/);
  });
});
