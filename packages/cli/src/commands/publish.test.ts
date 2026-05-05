import { describe, it, expect } from 'vitest';
import { parseGitHubRepo, buildSubmissionUrl } from './publish.js';

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
