import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VALID_CATEGORIES } from '../packages/backend/src/lib/apps.js';

const ROOT = join(import.meta.dirname, '..');

// #679: the CLI and console can't import the backend, so each keeps a copy of
// the publish categories; a missing one made `fas publish --category lifestyle`
// fail though the backend accepts it.
const COPIES = [
  'packages/cli/src/commands/publish.ts',
  'sites/console/web/src/PublishForm.tsx',
  'sites/console/web/src/builder/components/studio/PublishModal.tsx',
];

describe('publish categories', () => {
  it.each(COPIES)('%s lists exactly the backend categories', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const list = /\[([^[\]]*["']Productivity["'][^[\]]*)\]/.exec(src);
    expect(list, `${file} has a category list`).not.toBeNull();
    const entries = [...list![1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    expect(entries).toEqual([...VALID_CATEGORIES]);
  });
});
