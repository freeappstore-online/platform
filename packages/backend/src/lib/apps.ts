/**
 * Shared app-id validation. Several per-app routes (kv, counters, db, email,
 * rooms) are scoped by the `:appId` path segment, which is attacker-controlled
 * free text. Without an existence check a single user can reset every per-app
 * quota simply by rotating the id (`/apps/x1/...`, `/apps/x2/...`), so validate
 * the shape AND that the app is a real, published row before any write.
 */
import type { Env } from '../types.js';

export const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** True iff `appId` is well-formed and exists in the apps registry. */
export async function appExists(env: Env, appId: string): Promise<boolean> {
  if (!APP_ID_RE.test(appId)) return false;
  const row = await env.DB.prepare('SELECT 1 FROM apps WHERE id = ?').bind(appId).first();
  return !!row;
}
