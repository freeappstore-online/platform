/**
 * Shared app-id validation. Several per-app routes (kv, counters, db, email,
 * rooms) are scoped by the `:appId` path segment, which is attacker-controlled
 * free text. Without an existence check a single user can reset every per-app
 * quota simply by rotating the id (`/apps/x1/...`, `/apps/x2/...`), so validate
 * the shape AND that the app is a real, published row before any write.
 */
import type { Env } from '../types.js';
import { FAS_APP_ROWS } from './auth.js';

/**
 * App ids: 2-31 chars, a lowercase letter first, a letter or digit last,
 * lowercase letters, digits and hyphens between. They become DNS labels
 * (<id>.freeappstore.online), which can't end with a hyphen. Vendored into
 * the CLI, console, admin and agent; apps.test.ts keeps the copies equal (#279).
 */
export const APP_ID_RE = /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/;

export { isReservedAppId, RESERVED_APP_IDS } from './reserved-app-ids.js';

/**
 * Store categories /v1/publish accepts (case-insensitive). The MCP worker
 * imports this list; the CLI and console keep copies, which
 * scripts/categories.test.ts keeps equal to it (#679).
 */
export const VALID_CATEGORIES = [
  'Learning',
  'Strategy',
  'Discovery',
  'Brain Training',
  'Social',
  'Productivity',
  'Lifestyle',
  'Health & Fitness',
  'Finance',
  'Creative',
  'News & Weather',
  'Utilities',
  'Other (specify in description)',
] as const;

/** True iff `appId` is well-formed and exists in the apps registry. */
export async function appExists(env: Env, appId: string): Promise<boolean> {
  if (!APP_ID_RE.test(appId)) return false;
  const row = await env.DB.prepare(`SELECT 1 FROM apps WHERE id = ? AND ${FAS_APP_ROWS}`)
    .bind(appId)
    .first();
  return !!row;
}
