import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The release runner is plain Node ESM, shared by GitHub workflows.
import { apply, canonical, compareVersions, planSync } from './template-release.mjs';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const old = { cliVersion: '0.4.71', hashes: { 'web/app.ts': hash('old') } };
describe('accepted template synchronization', () => {
  it('updates canonical files, removes retired ones, and preserves extras', () => {
    const plan = planSync(
      old,
      { 'web/app.ts': 'old', 'custom.md': 'keep' },
      { 'web/new.ts': 'new' },
      '0.4.72',
    );
    expect(plan.writes).toEqual({ 'web/new.ts': 'new' });
    expect(plan.deletes).toEqual(['web/app.ts']);
    expect(plan.hashes).not.toHaveProperty('custom.md');
  });
  it('does nothing when regenerated from the same release', () => {
    const plan = planSync(old, { 'web/app.ts': 'old' }, { 'web/app.ts': 'old' }, '0.4.71');
    expect(plan.writes).toEqual({});
    expect(plan.deletes).toEqual([]);
  });
  it('refuses missing baselines, modified/deleted canonical files, path collisions and older releases', () => {
    expect(() => planSync(null, {}, {}, '0.4.72')).toThrow('baseline');
    expect(() => planSync(old, { 'web/app.ts': 'edited' }, {}, '0.4.72')).toThrow(
      'Manual canonical edit',
    );
    expect(() => planSync(old, {}, {}, '0.4.72')).toThrow('Manual canonical edit');
    expect(() =>
      planSync(old, { 'web/app.ts': 'old', 'new': 'mine' }, { new: 'theirs' }, '0.4.72'),
    ).toThrow('conflicts');
    expect(() => planSync(old, { 'web/app.ts': 'old' }, {}, '0.4.70')).toThrow('downgrade');
    expect(compareVersions('0.10.0', '0.9.99')).toBeGreaterThan(0);
  });
});

it('bootstraps reviewed files and preserves an extra file through repeated application', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fas-mirror-sync-'));
  try {
    const files = await canonical(process.cwd(), 'standalone');
    for (const [path, body] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), body as string);
    }
    await writeFile(join(root, 'custom.md'), 'keep');
    const release = { cliVersion: '0.4.72', sdkVersion: '0.16.37', sourceSha: 'a'.repeat(40) };
    await apply(root, process.cwd(), 'standalone', release, true);
    const baseline = await readFile(join(root, '.fas-template/state.json'), 'utf8');
    await apply(root, process.cwd(), 'standalone', release);
    expect(await readFile(join(root, '.fas-template/state.json'), 'utf8')).toBe(baseline);
    expect(await readFile(join(root, 'custom.md'), 'utf8')).toBe('keep');
    await writeFile(join(root, 'web/src/App.tsx'), 'manual change');
    await expect(apply(root, process.cwd(), 'standalone', release)).rejects.toThrow(
      'Manual canonical edit',
    );
    await writeFile(join(root, 'web/src/App.tsx'), files['web/src/App.tsx']);
    await rm(join(root, 'web/src/App.tsx'));
    await symlink(join(root, 'custom.md'), join(root, 'web/src/App.tsx'));
    await expect(apply(root, process.cwd(), 'standalone', release)).rejects.toThrow(
      'Symlink conflict',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('builds a relocated pinned workspace from a mirror working directory', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'fas-mirror-build-'));
  try {
    const platform = join(root, 'platform');
    const mirror = join(root, 'mirror');
    await mkdir(join(platform, 'packages/cli'), { recursive: true });
    await mkdir(mirror);
    await writeFile(
      join(platform, 'package.json'),
      JSON.stringify({ private: true, packageManager: 'pnpm@10.30.3' }),
    );
    await writeFile(join(platform, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(
      join(platform, 'packages/cli/package.json'),
      JSON.stringify({ name: '@freeappstore/cli', scripts: { build: 'node build.cjs' } }),
    );
    await writeFile(
      join(platform, 'packages/cli/build.cjs'),
      "require('fs').mkdirSync('dist/lib',{recursive:true});require('fs').writeFileSync('dist/lib/starter-foundation.js','export {}');",
    );
    const workflow = await readFile('scripts/mirror-sync-workflow.yml', 'utf8');
    const build = workflow
      .split('\n')
      .find((line) => line.includes('pnpm -r --filter'))!
      .trim();
    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    execFileSync(shell, ['-ec', `platform="$FAS_TEST_PLATFORM"\n${build}`], {
      cwd: mirror,
      env: { ...process.env, FAS_TEST_PLATFORM: platform },
      stdio: 'pipe',
    });
    expect(
      await readFile(join(platform, 'packages/cli/dist/lib/starter-foundation.js'), 'utf8'),
    ).toBe('export {}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
