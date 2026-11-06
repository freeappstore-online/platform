import { describe, expect, it } from 'vitest';
import { APP_STARTER_CONFIG, deployWorkflow } from '../packages/cli/src/lib/starter-foundation.js';
// @ts-expect-error -- plain .mjs script without declarations
import { COMMIT_MESSAGE, classify, fasJsonFor } from './fleet-deploy-workflow.mjs';

const generated = deployWorkflow(APP_STARTER_CONFIG);

/** The single-job workflow most of the fleet still runs (vcqa variant). */
const LEGACY = `name: Deploy to R2

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install
        run: pnpm install --frozen-lockfile
      # Example:
      #   env:
      #     VITE_GOOGLE_CLIENT_ID: \${{ vars.VITE_GOOGLE_CLIENT_ID }}
      - name: Build
        run: pnpm build
      - name: Upload to R2
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_ACCOUNT_ID: \${{ secrets.R2_ACCOUNT_ID }}
        run: aws s3 sync ./web/dist "s3://fas-apps/apps/\${GITHUB_REPOSITORY##*/}/" --delete
      - name: Code health scan
        run: npx @vibecodeqa/cli@0.31 --json --badge > /dev/null 2>&1 || true
`;

describe('fleet deploy workflow classification', () => {
  it('skips a repo that already runs the generator output (idempotent)', () => {
    expect(classify(generated, generated)).toEqual({ variant: 'current', review: [] });
  });

  it('rewrites the standard legacy shapes without review', () => {
    expect(classify(LEGACY, generated)).toEqual({ variant: 'legacy-vcqa', review: [] });
    const minimal = LEGACY.replace(/ {6}- name: Code health scan[\s\S]*$/, '');
    expect(classify(minimal, generated).variant).toBe('legacy-minimal');
  });

  it('a commented-out vars example is not a repo variable', () => {
    expect(classify(LEGACY, generated).review).not.toContain('repo variables');
  });

  it.each([
    [
      'a repo variable',
      LEGACY.replace(
        '        run: pnpm build',
        '        env:\n          VITE_KEY: ${{ vars.VITE_KEY }}\n        run: pnpm build',
      ),
      /repo variables/,
    ],
    [
      'another secret',
      LEGACY.replace('R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}', 'X: ${{ secrets.SENTRY }}'),
      /secrets SENTRY/,
    ],
    [
      'an extra step',
      LEGACY.replace(
        '      - name: Build',
        '      - name: Generate data\n        run: node gen.js\n      - name: Build',
      ),
      /step "Generate data"/,
    ],
    ['another sync source', LEGACY.replace('sync ./web/dist', 'sync ./dist'), /syncs \.\/dist/],
    [
      'another build command',
      LEGACY.replace('run: pnpm build', 'run: pnpm build:prod'),
      /build command/,
    ],
    [
      'a schedule',
      LEGACY.replace(
        '  workflow_dispatch:',
        '  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"',
      ),
      /triggers/,
    ],
    [
      'a third-party action',
      LEGACY.replace('actions/checkout@v4', 'evil/checkout@v1'),
      /action evil/,
    ],
  ])('sends a workflow with %s to hand review', (_name, text, reason) => {
    expect(classify(text, generated).review.join('; ')).toMatch(reason);
  });

  it('flags a missing workflow', () => {
    expect(classify(null, generated).review).toEqual(['no deploy.yml']);
  });

  it('regenerates an older keyless workflow (a generator bump) without review', () => {
    const older = generated.replace(/@freeappstore\/cli@[\d.]+/g, '@freeappstore/cli@0.4.1');
    expect(classify(older, generated)).toEqual({ variant: 'keyless-outdated', review: [] });
  });

  it('states the legacy build target in fas.json, with the deployment id', () => {
    expect(JSON.parse(fasJsonFor('weather'))).toEqual({
      appId: 'weather',
      applicationRoot: 'web',
      outputPath: 'web/dist',
      buildCommand: 'pnpm build',
    });
  });

  it('commits with the issue references and attribution', () => {
    expect(COMMIT_MESSAGE).toMatch(/^ci: /);
    expect(COMMIT_MESSAGE).toContain(
      'Refs freeappstore-online/platform#460, freeappstore-online/platform#523',
    );
    expect(COMMIT_MESSAGE.trim().split('\n').at(-1)).toBe(
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    );
  });
});
