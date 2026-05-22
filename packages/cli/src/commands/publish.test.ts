import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPromptList,
  buildSubmissionUrl,
  DEPLOY_YML,
  ensureDeployWorkflow,
  parseGitHubRepo,
  resolveCategory,
  resolveFromFlags,
  resolveType,
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

describe('buildSubmissionUrl', () => {
  const baseInput = {
    name: 'my-app',
    category: 'Productivity' as const,
    type: 'Standalone (no backend, localStorage only)' as const,
    oneliner: 'A quick way to track tasks',
    description: 'Detailed description here.',
    repo: null,
    demo: null,
  };

  it('builds a github.com submission URL with the right template', () => {
    const url = new URL(buildSubmissionUrl(baseInput));
    expect(url.host).toBe('github.com');
    expect(url.pathname).toBe('/freeappstore-online/submissions/issues/new');
    expect(url.searchParams.get('template')).toBe('app-submission.yml');
  });

  it('prefills every required template field', () => {
    const url = new URL(buildSubmissionUrl(baseInput));
    expect(url.searchParams.get('name')).toBe('my-app');
    expect(url.searchParams.get('category')).toBe('Productivity');
    expect(url.searchParams.get('type')).toBe(baseInput.type);
    expect(url.searchParams.get('oneliner')).toBe('A quick way to track tasks');
    expect(url.searchParams.get('description')).toBe('Detailed description here.');
    expect(url.searchParams.get('title')).toBe('[Submission] my-app');
  });

  it('includes repo when present, omits when null', () => {
    const withRepo = new URL(buildSubmissionUrl({ ...baseInput, repo: 'https://github.com/me/x' }));
    expect(withRepo.searchParams.get('repo')).toBe('https://github.com/me/x');
    const without = new URL(buildSubmissionUrl(baseInput));
    expect(without.searchParams.has('repo')).toBe(false);
  });

  it('includes demo when present, omits when null', () => {
    const withDemo = new URL(buildSubmissionUrl({ ...baseInput, demo: 'https://demo.example' }));
    expect(withDemo.searchParams.get('demo')).toBe('https://demo.example');
    const without = new URL(buildSubmissionUrl(baseInput));
    expect(without.searchParams.has('demo')).toBe(false);
  });

  it('properly URL-encodes special characters in description', () => {
    const url = new URL(
      buildSubmissionUrl({
        ...baseInput,
        description: 'A "quoted" thing & more (with parens)',
      }),
    );
    expect(url.searchParams.get('description')).toBe('A "quoted" thing & more (with parens)');
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
    expect(DEPLOY_YML).toContain('${{ secrets.R2_ACCESS_KEY_ID }}');
    expect(DEPLOY_YML).toContain('${{ secrets.R2_SECRET_ACCESS_KEY }}');
    expect(DEPLOY_YML).toContain('${{ secrets.R2_ACCOUNT_ID }}');
  });

  it('uploads to the correct R2 bucket path', () => {
    expect(DEPLOY_YML).toContain('s3://fas-apps/apps/');
  });

  it('includes build verification step', () => {
    expect(DEPLOY_YML).toContain('Verify build output');
    expect(DEPLOY_YML).toContain('web/dist');
  });
});

describe('ensureDeployWorkflow', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
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

  it('creates deploy.yml when missing and returns true', async () => {
    const result = await ensureDeployWorkflow();
    expect(result).toBe(true);
    const created = readFileSync(join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(created).toBe(DEPLOY_YML);
  });

  it('creates .github/workflows/ directories recursively', async () => {
    await ensureDeployWorkflow();
    expect(existsSync(join(tmpDir, '.github', 'workflows'))).toBe(true);
  });

  it('returns false and does not overwrite when deploy.yml already exists', async () => {
    const dir = join(tmpDir, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    const existing = 'name: Existing workflow\n';
    writeFileSync(join(dir, 'deploy.yml'), existing);

    const result = await ensureDeployWorkflow();
    expect(result).toBe(false);
    const content = readFileSync(join(dir, 'deploy.yml'), 'utf8');
    expect(content).toBe(existing);
  });
});
