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

  it('applies the host routes migrations before the admin upload', () => {
    const workflow = read('.github/workflows/deploy-admin.yml');
    beforeDeploy(
      workflow,
      'pnpm exec wrangler d1 migrations apply fas --remote --config ../host/wrangler.toml',
    );
  });
});
