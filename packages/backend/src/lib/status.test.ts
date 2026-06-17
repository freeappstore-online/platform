import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import { runStatusChecks, type StatusReport } from './status.js';

/** Minimal env mock: a D1 that returns {ok:1} and an ADMIN binding that 200s. */
function mockEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  const base = {
    DB: {
      prepare: () => ({ first: async () => ({ ok: 1 }) }),
    },
    ADMIN: {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    },
    ADMIN_PROVISION_TOKEN: 'token-x',
    CROSS_STORE_REGISTER_TOKEN: 'token-y',
  };
  return { ...base, ...overrides } as unknown as Env;
}

const find = (report: StatusReport, name: string) => report.checks.find((c) => c.name === name)!;

describe('runStatusChecks', () => {
  it('reports ok when DB and admin auth both pass', async () => {
    const report = await runStatusChecks(mockEnv());
    expect(report.status).toBe('ok');
    expect(find(report, 'db').status).toBe('ok');
    expect(find(report, 'admin_provision_auth').status).toBe('ok');
  });

  it('goes degraded when admin rejects the provisioning token (the drift case)', async () => {
    const report = await runStatusChecks(
      mockEnv({
        ADMIN: { fetch: async () => new Response('Unauthorized', { status: 401 }) },
      }),
    );
    expect(report.status).toBe('degraded');
    const check = find(report, 'admin_provision_auth');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/drift/i);
  });

  it('stays ok on a 404 from admin (ping route not yet deployed — auth still passed)', async () => {
    const report = await runStatusChecks(
      mockEnv({
        ADMIN: { fetch: async () => new Response('not found', { status: 404 }) },
      }),
    );
    expect(report.status).toBe('ok');
    expect(find(report, 'admin_provision_auth').status).toBe('ok');
  });

  it('goes degraded when admin returns 5xx (admin down)', async () => {
    const report = await runStatusChecks(
      mockEnv({
        ADMIN: { fetch: async () => new Response('boom', { status: 502 }) },
      }),
    );
    expect(report.status).toBe('degraded');
    expect(find(report, 'admin_provision_auth').detail).toMatch(/unhealthy/i);
  });

  it('goes degraded when the ADMIN binding is missing', async () => {
    const report = await runStatusChecks(mockEnv({ ADMIN: undefined }));
    expect(report.status).toBe('degraded');
    expect(find(report, 'admin_provision_auth').detail).toMatch(/not configured/i);
  });

  it('goes degraded when ADMIN_PROVISION_TOKEN is unset', async () => {
    const report = await runStatusChecks(mockEnv({ ADMIN_PROVISION_TOKEN: undefined }));
    expect(report.status).toBe('degraded');
    expect(find(report, 'admin_provision_auth').detail).toMatch(/not set/i);
  });

  it('goes degraded when the DB query throws', async () => {
    const report = await runStatusChecks(
      mockEnv({
        DB: {
          prepare: () => ({
            first: async () => {
              throw new Error('no such table');
            },
          }),
        },
      }),
    );
    expect(report.status).toBe('degraded');
    expect(find(report, 'db').status).toBe('fail');
  });

  it('stays ok when only a non-critical probe fails (missing cross-store token)', async () => {
    const report = await runStatusChecks(mockEnv({ CROSS_STORE_REGISTER_TOKEN: undefined }));
    expect(report.status).toBe('ok');
    expect(find(report, 'cross_store_register_token').status).toBe('fail');
  });

  it('records latency and an ISO timestamp', async () => {
    const report = await runStatusChecks(mockEnv());
    expect(typeof report.time).toBe('string');
    expect(Number.isNaN(Date.parse(report.time))).toBe(false);
    expect(find(report, 'db').latencyMs).toBeGreaterThanOrEqual(0);
  });
});
