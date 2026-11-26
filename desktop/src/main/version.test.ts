import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBuildInfo, releaseNotesUrl, versionLabel } from './version.js';

describe('version (#832)', () => {
  it('labels release and dev builds with their build number and commit', () => {
    expect(versionLabel('0.3.0', { build: '57', commit: 'abc1234' })).toBe('0.3.0 (57, abc1234)');
    expect(versionLabel('0.3.0', { build: 'dev', commit: 'abc1234' })).toBe('0.3.0 (dev, abc1234)');
  });

  it('reads build-info.json', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fas-build-')), 'build-info.json');
    writeFileSync(path, '{"build":"57","commit":"abc1234"}\n');
    expect(loadBuildInfo(path)).toEqual({ build: '57', commit: 'abc1234' });
  });

  it('links the release notes of the version', () => {
    expect(releaseNotesUrl('0.3.0')).toBe(
      'https://github.com/freeappstore-online/platform/releases/tag/desktop-v0.3.0',
    );
  });
});
