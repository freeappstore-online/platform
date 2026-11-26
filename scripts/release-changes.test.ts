import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const helper = new URL('./release-changes.sh', import.meta.url).pathname;
const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function commit(files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git('add', '-A');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}
const manifest = (version: string) =>
  `{\n  "name": "@freeappstore/sdk",\n  "version": "${version}"\n}\n`;
const logger = (version: string) => `export const SDK_VERSION = '${version}';\n`;
function changed(published: string) {
  const result = spawnSync(
    bash,
    ['-c', `source '${helper}' && changed_since_published packages/sdk '${published}'`],
    { cwd: repo, encoding: 'utf8' },
  );
  return result.status === 0;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'fas-release-changes-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('release decision from the published source (#780, #803)', () => {
  it('ignores commits that only move the version stamps', () => {
    const published = commit(
      {
        'packages/sdk/package.json': manifest('0.21.6'),
        'packages/sdk/src/logger.ts': logger('0.21.6'),
      },
      'release source',
    );
    commit(
      {
        'packages/sdk/package.json': manifest('0.21.7'),
        'packages/sdk/src/logger.ts': logger('0.21.7'),
      },
      'chore: auto-bump',
    );
    expect(changed(published)).toBe(false);
  });

  it('releases a change that a later version-sync commit sits on top of', () => {
    const published = commit({ 'packages/sdk/package.json': manifest('0.21.6') }, 'published');
    commit({ 'packages/sdk/src/bridge.ts': 'export {};\n' }, 'feat: bridge');
    // A heal (#803) or a bump commit rebased over the change (#780).
    commit({ 'packages/sdk/package.json': manifest('0.21.7') }, 'chore: auto-bump');
    expect(changed(published)).toBe(true);
  });

  it('ignores changes outside the package', () => {
    const published = commit({ 'packages/sdk/package.json': manifest('0.21.6') }, 'published');
    commit({ 'packages/cli/index.ts': 'export {};\n' }, 'cli only');
    expect(changed(published)).toBe(false);
  });

  it('never releases a checkout that npm is already ahead of', () => {
    commit({ 'packages/sdk/package.json': manifest('0.21.6') }, 'old');
    const older = git('rev-parse', 'HEAD');
    const published = commit({ 'packages/sdk/src/bridge.ts': 'export {};\n' }, 'newer, published');
    git('checkout', '-q', older);
    expect(changed(published)).toBe(false);
  });

  it('treats an unknown published source as changed', () => {
    commit({ 'packages/sdk/package.json': manifest('0.21.6') }, 'published');
    expect(changed('')).toBe(true);
    expect(changed('0000000000000000000000000000000000000000')).toBe(true);
  });

  it('is what the publish workflow decides with', () => {
    expect(workflow).toContain('source scripts/release-changes.sh');
    expect(workflow).toContain('changed_since_published "packages/$PKG" "$PUBLISHED_SRC"');
    expect(workflow).not.toContain(`git log -G'"version"'`);
  });
});
