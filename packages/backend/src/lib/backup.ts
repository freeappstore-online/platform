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

const PLAIN_TABLES = [
  'users',
  'apps',
  'health_checks',
  'app_secrets',
  'app_proxy_allowlist',
  'app_proxy_usage',
  'app_analytics',
  'key_providers',
  'app_logs',
  'app_webhooks',
  'webhook_deliveries',
  'agent_sessions',
  'audit_results',
  'counters',
  'documents',
  'app_roles',
] as const;

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
    try {
      const { results } = await db.prepare(`SELECT * FROM ${name}`).all();
      tables[name] = results;
      rowsByTable[name] = results.length;
    } catch {
      // Table may not exist yet (migration not applied). Skip silently —
      // the backup is best-effort; missing tables are obvious from the
      // rowsByTable counts.
      rowsByTable[name] = -1;
    }
  }

  // kv.value is a BLOB — emit hex so the round-trip survives JSON.
  const { results: kvRows } = await db
    .prepare(
      `SELECT app_id, user_id, key, hex(value) AS value_hex,
              value_size_bytes, updated_at
       FROM kv`,
    )
    .all();
  tables.kv = kvRows;
  rowsByTable.kv = kvRows.length;

  // user_api_keys has BLOB columns for encrypted key material.
  const { results: keyRows } = await db
    .prepare(
      `SELECT user_id, provider, label,
              hex(key_ciphertext) AS key_ciphertext_hex,
              hex(dek_wrapped) AS dek_wrapped_hex,
              hex(iv) AS iv_hex,
              created_at, last_used_at
       FROM user_api_keys`,
    )
    .all();
  tables.user_api_keys = keyRows;
  rowsByTable.user_api_keys = keyRows.length;

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
