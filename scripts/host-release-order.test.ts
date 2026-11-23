import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

function beforeDeploy(workflow: string, command: string) {
  const migrate = workflow.indexOf(command);
  const deploy = workflow.indexOf('pnpm exec wrangler deploy');
  expect(migrate, command).toBeGreaterThan(-1);
  expect(deploy).toBeGreaterThan(migrate);
}

describe('host schema is applied before dependent releases (#308)', () => {
  it('applies routes migrations before the host upload, then checks the live fleet', () => {
    const workflow = read('.github/workflows/deploy-host.yml');
    beforeDeploy(workflow, 'pnpm exec wrangler d1 migrations apply fas --remote');
    const deploy = workflow.indexOf('pnpm exec wrangler deploy');
    const verify = workflow.indexOf('node scripts/verify-app-host.mjs');
    expect(verify).toBeGreaterThan(deploy);
  });

  it('rolls the host back with wrangler when the live check fails (#643)', () => {
    const workflow = read('.github/workflows/deploy-host.yml');
    const verify = workflow.indexOf('node scripts/verify-app-host.mjs');
    const rollback = workflow.indexOf('pnpm exec wrangler rollback --yes');
    expect(rollback).toBeGreaterThan(verify);
    const step = workflow.slice(workflow.lastIndexOf('- name:', rollback), rollback);
    expect(step).toContain(
      "if: failure() && steps.deploy.outcome == 'success' && steps.verify.outcome == 'failure'",
    );
    expect(workflow).toContain('id: deploy\n');
    expect(workflow).toContain('id: verify\n');
  });

  it('applies the host routes migrations before the admin upload', () => {
    const workflow = read('.github/workflows/deploy-admin.yml');
    beforeDeploy(
      workflow,
      'pnpm exec wrangler d1 migrations apply fas --remote --config ../host/wrangler.toml',
    );
  });
});
