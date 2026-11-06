import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_STARTER_CONFIG, deployWorkflow } from '../lib/starter-foundation.js';
import {
  buildPromptList,
  DEPLOY_YML,
  ensureDeployWorkflow,
  humanizeProvisionError,
  parseGitHubRepo,
  readCrossOriginIsolatedFlag,
  resolveCategory,
  resolveFromFlags,
  resolveType,
  summarizeWorkflowDrift,
} from './publish.js';

describe('parseGitHubRepo', () => {
  it('parses HTTPS clone URLs', () => {
    expect(parseGitHubRepo('https://github.com/foo/bar')).toBe('foo/bar');
    expect(parseGitHubRepo('https://github.com/foo/bar.git')).toBe('foo/bar');
    expect(parseGitHubRepo('https://github.com/foo/bar/')).toBe('foo/bar');
    expect(parseGitHubRepo('https://github.com/foo/bar.git/')).toBe('foo/bar');
  });

  it('parses SSH clone URLs', () => {
    expect(parseGitHubRepo('git@github.com:foo/bar.git')).toBe('foo/bar');
    expect(parseGitHubRepo('git@github.com:foo/bar')).toBe('foo/bar');
  });

  it('allows dots in repo names (e.g. node.js, foo.config)', () => {
    expect(parseGitHubRepo('https://github.com/nodejs/node.js')).toBe('nodejs/node.js');
    expect(parseGitHubRepo('git@github.com:nodejs/node.js.git')).toBe('nodejs/node.js');
  });

  it('allows hyphens, underscores, and digits', () => {
    expect(parseGitHubRepo('https://github.com/foo-bar/baz_qux-2')).toBe('foo-bar/baz_qux-2');
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRepo('https://gitlab.com/foo/bar')).toBeNull();
    expect(parseGitHubRepo('https://example.com/repo')).toBeNull();
    expect(parseGitHubRepo('not a url')).toBeNull();
    expect(parseGitHubRepo('')).toBeNull();
  });
});

describe('resolveCategory', () => {
  it('matches exact label', () => {
    expect(resolveCategory('Productivity')).toBe('Productivity');
  });
  it('matches case-insensitive', () => {
    expect(resolveCategory('utilities')).toBe('Utilities');
    expect(resolveCategory('UTILITIES')).toBe('Utilities');
    expect(resolveCategory('  Brain Training  ')).toBe('Brain Training');
  });
  it('matches "other" short form', () => {
    expect(resolveCategory('other')).toBe('Other (specify in description)');
  });
  it('returns null for unknown', () => {
    expect(resolveCategory('nope')).toBeNull();
    expect(resolveCategory('')).toBeNull();
  });
});

describe('resolveType', () => {
  it('matches short forms', () => {
    expect(resolveType('standalone')).toBe('Standalone (no backend, localStorage only)');
    expect(resolveType('connected')).toBe(
      'Connected (Firebase/Supabase backend, shared with Pro version)',
    );
  });
  it('matches case-insensitive full label', () => {
    expect(resolveType('STANDALONE')).toBe('Standalone (no backend, localStorage only)');
  });
  it('returns null for unknown', () => {
    expect(resolveType('something')).toBeNull();
  });
});

describe('resolveFromFlags', () => {
  it('returns empty values when no flags supplied', () => {
    const r = resolveFromFlags({});
    expect(r.values).toEqual({});
    expect(r.errors).toEqual([]);
  });
  it('resolves valid combinations', () => {
    const r = resolveFromFlags({
      name: 'my-app',
      category: 'utilities',
      type: 'standalone',
      oneliner: 'Does a thing',
      demo: 'https://demo.example',
    });
    expect(r.errors).toEqual([]);
    expect(r.values.name).toBe('my-app');
    expect(r.values.category).toBe('Utilities');
    expect(r.values.type).toBe('Standalone (no backend, localStorage only)');
    expect(r.values.oneliner).toBe('Does a thing');
    expect(r.values.demo).toBe('https://demo.example');
  });
  it('treats blank --demo as null', () => {
    const r = resolveFromFlags({ demo: '   ' });
    expect(r.values.demo).toBeNull();
  });
  it('rejects invalid app id', () => {
    const r = resolveFromFlags({ name: 'BadName' });
    expect(r.errors[0]).toMatch(/--name/);
    expect(r.values.name).toBeUndefined();
  });
  it('rejects unknown category and type', () => {
    const r = resolveFromFlags({ category: 'nope', type: 'foo' });
    expect(r.errors).toHaveLength(2);
  });
  it('rejects empty oneliner', () => {
    const r = resolveFromFlags({ oneliner: '   ' });
    expect(r.errors[0]).toMatch(/oneliner/);
  });
});

describe('buildPromptList', () => {
  const defaults = { appName: null, description: null };
  it('returns all 5 prompts when nothing resolved', () => {
    expect(buildPromptList({}, defaults).map((p) => p.name)).toEqual([
      'name',
      'category',
      'type',
      'oneliner',
      'demo',
    ]);
  });
  it('skips a prompt when its value is already resolved', () => {
    const list = buildPromptList(
      { name: 'my-app', category: 'Utilities', type: 'Standalone (no backend, localStorage only)' },
      defaults,
    );
    expect(list.map((p) => p.name)).toEqual(['oneliner', 'demo']);
  });
  it('returns empty list when everything resolved', () => {
    expect(
      buildPromptList(
        {
          name: 'x',
          category: 'Utilities',
          type: 'Standalone (no backend, localStorage only)',
          oneliner: 'y',
          demo: null,
        },
        defaults,
      ),
    ).toEqual([]);
  });
});

describe('DEPLOY_YML', () => {
  it('is valid YAML with expected GitHub Actions structure', () => {
    expect(DEPLOY_YML).toContain('name: Deploy to R2');
    expect(DEPLOY_YML).toContain('on:');
    expect(DEPLOY_YML).toContain('push:');
    expect(DEPLOY_YML).toContain('branches: [main]');
    expect(DEPLOY_YML).toContain('workflow_dispatch:');
    expect(DEPLOY_YML).toContain('jobs:');
  });

  it('references the three required R2 secrets', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    expect(DEPLOY_YML).toContain('${{ secrets.R2_ACCESS_KEY_ID }}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    expect(DEPLOY_YML).toContain('${{ secrets.R2_SECRET_ACCESS_KEY }}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    expect(DEPLOY_YML).toContain('${{ secrets.R2_ACCOUNT_ID }}');
  });

  it('uploads to the correct R2 bucket path', () => {
    expect(DEPLOY_YML).toContain('s3://fas-apps/apps/');
  });

  it('includes build verification step', () => {
    expect(DEPLOY_YML).toContain('Verify build output');
    expect(DEPLOY_YML).toContain('build-target --artifact');
    expect(DEPLOY_YML).toContain('steps.target.outputs.output-path');
    expect(DEPLOY_YML).toContain('aws s3 sync .fas-deploy/app');
  });

  it('is the same workflow fas init and the builder generate', () => {
    expect(DEPLOY_YML).toBe(deployWorkflow(APP_STARTER_CONFIG));
  });
});

describe('ensureDeployWorkflow', () => {
  let tmpDir: string;
  let _origCwd: string;

  beforeEach(() => {
    _origCwd = process.cwd();
    tmpDir = join(import.meta.dirname, '..', '..', 'node_modules', '.cache', `test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up
    const { rmSync } = require('node:fs');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates deploy.yml when missing and returns "created"', async () => {
    const result = await ensureDeployWorkflow();
    expect(result).toBe('created');
    const created = readFileSync(join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(created).toBe(DEPLOY_YML);
  });

  it('creates .github/workflows/ directories recursively', async () => {
    await ensureDeployWorkflow();
    expect(existsSync(join(tmpDir, '.github', 'workflows'))).toBe(true);
  });

  it('returns "ok" when deploy.yml already matches the canonical workflow', async () => {
    const dir = join(tmpDir, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'deploy.yml'), DEPLOY_YML);

    expect(await ensureDeployWorkflow()).toBe('ok');
  });

  it('never overwrites a differing deploy.yml without --update-workflow; reports the drift', async () => {
    const dir = join(tmpDir, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    const existing = 'name: Deploy to R2\njobs:\n  deploy:\n    steps:\n      - run: echo custom\n';
    writeFileSync(join(dir, 'deploy.yml'), existing);

    const result = await ensureDeployWorkflow();
    expect(result).toEqual({ drift: expect.arrayContaining([expect.stringMatching(/line\(s\)/)]) });
    expect(readFileSync(join(dir, 'deploy.yml'), 'utf8')).toBe(existing);
  });

  it('leaves a legacy CF Pages workflow alone too, naming the reason', async () => {
    const dir = join(tmpDir, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    const legacy = 'name: Deploy to Cloudflare Pages\non: push\n';
    writeFileSync(join(dir, 'deploy.yml'), legacy);

    const result = await ensureDeployWorkflow();
    expect(result).toEqual({
      drift: expect.arrayContaining([expect.stringContaining('Cloudflare Pages')]),
    });
    expect(readFileSync(join(dir, 'deploy.yml'), 'utf8')).toBe(legacy);
  });

  it('returns "updated" and replaces the file when --update-workflow is set', async () => {
    const dir = join(tmpDir, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'deploy.yml'), 'name: Deploy to Cloudflare Pages\non: push\n');

    expect(await ensureDeployWorkflow({ update: true })).toBe('updated');
    expect(readFileSync(join(dir, 'deploy.yml'), 'utf8')).toBe(DEPLOY_YML);
  });
});

describe('summarizeWorkflowDrift', () => {
  const legacyPublishTemplate = [
    'jobs:',
    '  deploy:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: npx @freeappstore/cli build-target --github-output',
    '      - run: npx @vibecodeqa/cli@0.31 --json --badge',
    '      - env:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    '          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}',
    '        run: aws s3 sync web/dist s3://fas-apps/apps/x/',
    '',
  ].join('\n');

  it('names the security-relevant drift of the pre-0.4.78 publish template', () => {
    const reasons = summarizeWorkflowDrift(legacyPublishTemplate, DEPLOY_YML);
    expect(reasons).toEqual([
      'runs npx packages without an exact version (@freeappstore/cli, @vibecodeqa/cli@0.31)',
      'uses tag-pinned actions instead of commit SHAs (1)',
      'exposes the R2 secrets in the same job that installs and builds the app',
      expect.stringMatching(/^\d+ line\(s\) would be removed, \d+ added$/),
    ]);
  });

  it('reports only the line count for a customised copy of the canonical workflow', () => {
    const customised = DEPLOY_YML.replace('node-version: 22', 'node-version: 24');
    expect(summarizeWorkflowDrift(customised, DEPLOY_YML)).toEqual([
      '1 line(s) would be removed, 1 added',
    ]);
  });
});

describe('readCrossOriginIsolatedFlag', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, '..', '..', 'node_modules', '.cache', `coi-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    const { rmSync } = require('node:fs');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when fas.json is missing', async () => {
    expect(await readCrossOriginIsolatedFlag(tmpDir)).toBeUndefined();
  });

  it('returns undefined when the field is absent or not a boolean', async () => {
    writeFileSync(join(tmpDir, 'fas.json'), JSON.stringify({ apis: [] }));
    expect(await readCrossOriginIsolatedFlag(tmpDir)).toBeUndefined();
    writeFileSync(join(tmpDir, 'fas.json'), JSON.stringify({ crossOriginIsolated: 'yes' }));
    expect(await readCrossOriginIsolatedFlag(tmpDir)).toBeUndefined();
  });

  it('returns the boolean when set', async () => {
    writeFileSync(join(tmpDir, 'fas.json'), JSON.stringify({ crossOriginIsolated: true }));
    expect(await readCrossOriginIsolatedFlag(tmpDir)).toBe(true);
    writeFileSync(
      join(tmpDir, 'fas.json'),
      JSON.stringify({ crossOriginIsolated: false, apis: [] }),
    );
    expect(await readCrossOriginIsolatedFlag(tmpDir)).toBe(false);
  });
});

describe('humanizeProvisionError', () => {
  it('summarizes a partial-failure step list with details', () => {
    const body = JSON.stringify({
      error: 'admin_provision_partial_failure',
      failedSteps: [{ name: 'github_repo', detail: 'name taken' }, { name: 'dns' }],
    });
    expect(humanizeProvisionError(502, body)).toBe(
      'provisioning step failed: github_repo (name taken); dns',
    );
  });

  it('joins error + hint for a known error shape', () => {
    const body = JSON.stringify({ error: 'wrong_store', hint: 'use fgs publish' });
    expect(humanizeProvisionError(410, body)).toBe('wrong_store — use fgs publish');
  });

  it('uses the bare error when there is no hint', () => {
    expect(humanizeProvisionError(502, JSON.stringify({ error: 'admin_provision_failed' }))).toBe(
      'admin_provision_failed',
    );
  });

  it('falls back to status + trimmed text for non-JSON bodies', () => {
    expect(humanizeProvisionError(400, 'category is required')).toBe('400: category is required');
  });

  it('handles an empty body', () => {
    expect(humanizeProvisionError(500, '')).toBe('server returned 500');
  });

  it('never returns a raw JSON blob (caps very long plain text)', () => {
    const long = 'x'.repeat(500);
    const out = humanizeProvisionError(502, long);
    expect(out.length).toBeLessThan(220);
  });
});
