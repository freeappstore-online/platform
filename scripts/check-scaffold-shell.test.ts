import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfig } from '../workers/agent/src/config';
import { APP_ARCHETYPES, getTemplateFiles } from '../workers/agent/src/template';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function check(files: Record<string, string>, preset = 'connected') {
  const dir = mkdtempSync(join(tmpdir(), 'fas-shell-'));
  fixtures.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const result = spawnSync(bash, [resolve('scripts/check-scaffold-shell.sh'), dir, preset], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe('fresh scaffold public-screen auth contract (#376)', () => {
  for (const preset of ['connected', 'standalone'] as const) {
    it.each(APP_ARCHETYPES)(`accepts canonical ${preset}/%s output`, (archetype) => {
      const result = check(getTemplateFiles(getConfig('apps'), archetype, preset), preset);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`OK: ${preset}`);
    });
  }

  it('accepts a connected feature gate without gating public screens', () => {
    const files = getTemplateFiles(getConfig('apps'), 'generic', 'connected');
    expect(files['web/src/components/ConnectedDraft.tsx']).toContain('<SignInButton app={fas} />');
    const result = check(files);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each(['current', 'legacy', 'absent'])(
    'rejects a global gate with %s component location',
    (location) => {
      const files = getTemplateFiles(getConfig('apps'), 'generic', 'connected');
      const component = files['web/src/components/ConnectedDraft.tsx'];
      if (location !== 'current') delete files['web/src/components/ConnectedDraft.tsx'];
      if (location === 'legacy') files['web/src/fas-capabilities/ConnectedDraft.tsx'] = component;
      files['web/src/App.tsx'] = files['web/src/App.tsx'].replace('<Shell ', '<Shell requireAuth ');
      const result = check(files);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('connected starter gates public screens with requireAuth');
    },
  );

  it.each(['connected', 'standalone'])('rejects multiline global gates in %s output', (preset) => {
    const files = getTemplateFiles(
      getConfig('apps'),
      'generic',
      preset as 'connected' | 'standalone',
    );
    files['web/src/App.tsx'] = files['web/src/App.tsx'].replace(
      '<Shell ',
      '<Shell\n requireAuth\n ',
    );
    const result = check(files, preset);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain(`${preset} starter gates public screens with requireAuth`);
  });
});
