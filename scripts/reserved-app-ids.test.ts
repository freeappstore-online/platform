import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESERVED_APP_IDS } from '../packages/backend/src/lib/reserved-app-ids.js';

const ROOT = join(import.meta.dirname, '..');
const CANONICAL = 'packages/backend/src/lib/reserved-app-ids.ts';

// #515: one reserved-app-id list. The three places that refuse a name import
// it; before, each kept its own copy and they drifted (the agent lacked mcp,
// console, keys, cli, hanzi, yi and template-*; the admin lacked legacy).
// Lists that name platform repos for another purpose, not to refuse an app id.
const NOT_COPIES = new Set([
  // Hides infra repos of both orgs from the VibeCode project picker.
  'sites/console/web/src/builder/components/ProjectPicker.tsx',
]);

const CONSUMERS = [
  'packages/backend/src/lib/apps.ts',
  'workers/admin/src/publish.ts',
  'workers/agent/src/infra-exec.ts',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      return ['node_modules', 'dist', 'build', 'public', '.wrangler'].includes(e.name)
        ? []
        : sourceFiles(path);
    }
    return /\.(ts|tsx|mts)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name) ? [path] : [];
  });
}

describe('reserved app ids', () => {
  it.each(CONSUMERS)('%s imports the canonical list', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).toMatch(/from ["'][./]*[^"']*reserved-app-ids(\.js)?["']/);
  });

  it('no other source keeps its own copy of the list', () => {
    const names = [...RESERVED_APP_IDS];
    const copies: string[] = [];
    for (const file of ['packages', 'workers', 'sites'].flatMap(sourceFiles)) {
      if (file === CANONICAL || NOT_COPIES.has(file)) continue;
      const src = readFileSync(join(ROOT, file), 'utf8');
      // An array or Set literal naming four or more reserved ids is a copy.
      for (const [literal] of src.matchAll(/\[[^\][]*\]/g)) {
        const hits = names.filter((n) => new RegExp(`["']${n}["']`).test(literal));
        if (hits.length >= 4) copies.push(`${file}: ${hits.join(', ')}`);
      }
    }
    expect(copies).toEqual([]);
  });

  it('includes the platform-looking hosts from #515', () => {
    for (const id of 'auth login signin sso account security support billing status oauth github verify publish www api'.split(
      ' ',
    )) {
      expect(RESERVED_APP_IDS.has(id), id).toBe(true);
    }
  });
});
