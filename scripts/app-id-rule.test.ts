import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ID_RE } from '../packages/backend/src/lib/apps.js';

const ROOT = join(import.meta.dirname, '..');

// #279: one app-id rule. Workers and sites can't import the backend, so each
// keeps a copy; an agent-deployed id outside the backend's rule went live but
// couldn't be listed, unpublished or transferred.
const COPIES = [
  'packages/cli/src/lib/app-id.ts',
  'sites/console/web/src/PublishForm.tsx',
  'sites/console/web/src/builder/components/studio/PublishModal.tsx',
  'workers/admin/src/transfer-owner.ts',
  'workers/agent/src/infra-exec.ts',
];

describe('APP_ID_RE', () => {
  it.each(COPIES)('%s uses the same rule as the backend', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const literals = [...src.matchAll(/\/\^\[a-z\][^/\n]*\$\//g)].map((m) => m[0]);
    expect(literals.length, `${file} has an app-id regex literal`).toBeGreaterThan(0);
    for (const literal of literals) expect(literal).toBe(`/${APP_ID_RE.source}/`);
  });

  it.each(['ab', 'timer', 'clone-2048', 'a'.repeat(31), 'my-cool-app-2'])('accepts %s', (id) => {
    expect(APP_ID_RE.test(id)).toBe(true);
  });

  it.each([
    ['x', 'one character'],
    ['a'.repeat(32), 'over 31 characters'],
    ['2048-clone', 'starts with a digit'],
    ['my-app-', 'ends with a hyphen (not a valid DNS label)'],
    ['-app', 'starts with a hyphen'],
    ['My-App', 'uppercase'],
    ['my_app', 'underscore'],
  ])('rejects %s (%s)', (id) => {
    expect(APP_ID_RE.test(id)).toBe(false);
  });
});
