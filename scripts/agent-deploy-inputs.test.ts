import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('agent shared resolver release wiring', () => {
  const workflow = readFileSync('.github/workflows/deploy-agent.yml', 'utf8');

  it.each([
    'packages/cli/src/lib/capability-definitions.ts',
    'packages/cli/src/lib/starter-presets.ts',
    'packages/compliance/**',
    'packages/backend/src/lib/web-push.ts',
  ])('redeploys when %s changes', (input) => {
    const paths = workflow.split('  workflow_dispatch:')[0];
    expect(paths).toContain(`- '${input}'`);
  });

  it('gates deployment on isolated bundling and the existing release checks', () => {
    const deploy = workflow.indexOf('run: pnpm exec wrangler deploy');
    for (const command of [
      'pnpm lint',
      'npx tsc --noEmit',
      'pnpm test',
      'pnpm test:runtime',
      'pnpm test:bundle',
    ]) {
      const position = workflow.indexOf(`run: ${command}\n`);
      expect(position).toBeGreaterThan(-1);
      expect(position).toBeLessThan(deploy);
    }
  });
});
