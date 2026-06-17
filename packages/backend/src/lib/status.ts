import type { Env } from '../types.js';

/**
 * Live dependency probes behind GET /status. Unlike /health (which only proves
 * this Worker is up), these actively call every downstream service the publish
 * flow depends on — so a broken backend↔admin token or an unreachable DB shows
 * up as a red probe instead of silently failing the next `fas publish`.
 *
 * A `critical` probe going red flips the whole report to "degraded" and makes
 * the endpoint return 503, which the post-deploy smoke and the scheduled probe
 * workflow treat as a hard failure.
 */
export interface StatusCheck {
  name: string;
  status: 'ok' | 'fail';
  detail: string;
  latencyMs: number;
  critical: boolean;
}

export interface StatusReport {
  status: 'ok' | 'degraded';
  checks: StatusCheck[];
  time: string;
}

async function probe(
  name: string,
  critical: boolean,
  fn: () => Promise<string>,
): Promise<StatusCheck> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, status: 'ok', detail, latencyMs: Date.now() - start, critical };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', detail, latencyMs: Date.now() - start, critical };
  }
}

/**
 * Run all probes concurrently and assemble the report. Never throws — a thrown
 * probe becomes a failed check so /status always responds.
 */
export async function runStatusChecks(env: Env): Promise<StatusReport> {
  const checks = await Promise.all([
    probe('db', true, async () => {
      const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
      if (row?.ok !== 1) throw new Error('D1 returned an unexpected result');
      return 'D1 reachable';
    }),

    // The exact failure mode of the 2026-06-17 outage: backend → admin via the
    // service binding, authenticated with ADMIN_PROVISION_TOKEN. If the tokens
    // drift apart again, this probe goes red BEFORE a creator hits it.
    probe('admin_provision_auth', true, async () => {
      if (!env.ADMIN) throw new Error('ADMIN service binding not configured');
      if (!env.ADMIN_PROVISION_TOKEN)
        throw new Error('ADMIN_PROVISION_TOKEN is not set on the backend');
      const res = await env.ADMIN.fetch('https://admin/api/ping', {
        headers: { 'X-Internal-Token': env.ADMIN_PROVISION_TOKEN },
      });
      // The admin auth gate returns 401/403 BEFORE routing, so any other status
      // proves the token was accepted — which is what this probe verifies. A 404
      // (e.g. admin deployed before its /api/ping route exists) still means auth
      // passed; only 401/403 indicate token drift, and 5xx means admin is down.
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `admin rejected the provisioning token (${res.status}) — backend↔admin token drift; \`fas publish\` would fail`,
        );
      }
      if (res.status >= 500) throw new Error(`admin unhealthy (HTTP ${res.status})`);
      return res.status === 404
        ? 'backend→admin auth OK (ping route not yet deployed)'
        : 'backend→admin provisioning auth OK';
    }),

    // Config sanity: the cross-store register token must exist for PAS→FAS
    // registration. Non-critical (dead path today) but surfaced so it can't
    // silently go missing.
    probe('cross_store_register_token', false, async () => {
      if (!env.CROSS_STORE_REGISTER_TOKEN) throw new Error('CROSS_STORE_REGISTER_TOKEN is not set');
      return 'configured';
    }),
  ]);

  const degraded = checks.some((c) => c.critical && c.status === 'fail');
  return {
    status: degraded ? 'degraded' : 'ok',
    checks,
    time: new Date().toISOString(),
  };
}
