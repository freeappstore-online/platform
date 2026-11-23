import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/status-probe.yml', import.meta.url),
  'utf8',
);

describe('status probe alerts on Worker cron burst failures (#642)', () => {
  it('reads the cron results, bursts live apps, and opens one labelled issue on failure', () => {
    expect(workflow).toContain('https://api.freeappstore.online/v1/uptime');
    expect(workflow).toContain('.recentFailures | length');
    expect(workflow).toContain('select(.target == "burst:run")');
    expect(workflow).toContain('node scripts/verify-app-host.mjs --burst-only');
    expect(workflow).toContain("if: always() && needs.probe.result != 'success'");
    expect(workflow).toContain("const label = 'uptime-failure'");
    expect(workflow).toMatch(/issues: write/);
  });
});
