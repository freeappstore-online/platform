/**
 * Daily snapshot of D1 → R2.
 *
 * Why JSON and not a SQL dump: D1 doesn't expose `.dump()` from a Worker,
 * so we emit row data as JSON. To restore, INSERT each row into a fresh
 * D1 instance. Format is documented as `version: 1` so we can change it
 * without breaking old backups.
 *
 * Why the BLOB column gets special handling: kv.value is binary. JSON
 * can't represent Uint8Array; stringifying it gives `{}`. We hex-encode
 * via SQLite's hex() so the round-trip is lossless.
 *
 * The audit DR.md flagged this as a gap. Closes it once R2 is enabled
 * on the account and the BACKUPS binding is configured in wrangler.toml.
 */

export interface BackupResult {
  key: string;
  bytes: number;
  rowsByTable: Record<string, number>;
}

const PLAIN_TABLES = ['users', 'apps', 'health_checks'] as const;

export async function backupD1ToR2(
  db: D1Database,
  bucket: R2Bucket,
  now: number = Date.now(),
): Promise<BackupResult> {
  const date = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `db-backups/${date}/fas.json`;

  const tables: Record<string, unknown[]> = {};
  const rowsByTable: Record<string, number> = {};

  for (const name of PLAIN_TABLES) {
    const { results } = await db.prepare(`SELECT * FROM ${name}`).all();
    tables[name] = results;
    rowsByTable[name] = results.length;
  }

  // kv.value is a BLOB — emit hex so the round-trip survives JSON.
  const { results: kvRows } = await db
    .prepare(
      `SELECT app_id, user_id, key, hex(value) AS value_hex,
              value_size_bytes, updated_at
       FROM kv`,
    )
    .all();
  tables['kv'] = kvRows;
  rowsByTable['kv'] = kvRows.length;

  const body = JSON.stringify({
    version: 1,
    exportedAt: now,
    tables,
  });

  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
  });

  return { key, bytes: body.length, rowsByTable };
}
