import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('agent shared resolver release wiring', () => {
  const workflow = readFileSync('.github/workflows/deploy-agent.yml', 'utf8');

  it('declares and resolves semver for root tests importing the worker template', () => {
    const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
    const workerPackage = JSON.parse(readFileSync('workers/agent/package.json', 'utf8'));
    expect(rootPackage.dependencies.semver).toBe(workerPackage.dependencies.semver);
    expect(rootPackage.devDependencies['@types/semver']).toBe(
      workerPackage.devDependencies['@types/semver'],
    );
    const rootRequire = createRequire(resolve('package.json'));
    const { validRange, minVersion, subset } = rootRequire('semver');
    expect(validRange('^7.8.6')).toBeTruthy();
    expect(minVersion('^7.8.6').version).toBe('7.8.6');
    expect(subset('^7.8.6', '^7.0.0')).toBe(true);
    expect(subset('^6.3.2', '^7.0.0')).toBe(false);
  });

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
