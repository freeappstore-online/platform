import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import desktop from '../lib/desktop-release.cjs';

const { ASSETS, RELEASES, publishedDesktopRelease, fetchDesktopRelease, renderDesktopRelease } = desktop;
const root = fileURLToPath(new URL('../', import.meta.url));
const template = readFileSync(join(root, 'download.html'), 'utf8');

function release(version = '0.6.0', overrides = {}) {
  const tag_name = `desktop-v${version}`;
  return {
    tag_name, draft: false, published_at: '2026-11-27T15:34:45Z',
    assets: ASSETS.map(name => ({ name, state: 'uploaded', size: 123, browser_download_url: `${RELEASES}/download/${tag_name}/${name}` })),
    ...overrides,
  };
}

test('selects a complete published desktop release, not an SDK release or mutable latest alias', () => {
  const selected = publishedDesktopRelease([
    release('999.0.0', { tag_name: 'sdk-v999.0.0' }),
    release('999.0.0', { tag_name: 'desktop-latest' }),
    release('0.9.0'), release('0.10.0'),
  ]);
  assert.equal(selected.version, '0.10.0');
  assert.equal(selected.publishedAt, '2026-11-27T15:34:45.000Z');
});

test('refuses drafts, unpublished dates, malformed tags and incomplete or foreign installers', () => {
  const valid = release('0.7.0');
  for (const bad of [
    { ...valid, draft: true }, { ...valid, draft: undefined },
    { ...valid, published_at: null }, { ...valid, published_at: 'not a date' },
    { ...valid, tag_name: 'desktop-v0.7.0"><script>' },
    { ...valid, assets: valid.assets.slice(1) },
    ...['size', 'state', 'browser_download_url'].map(key => ({ ...valid, assets: valid.assets.map((asset, i) =>
      i ? asset : { ...asset, [key]: key === 'size' ? 0 : key === 'state' ? 'new' : 'https://example.com/installer' }) })),
  ]) {
    assert.equal(publishedDesktopRelease([bad, release()]).version, '0.6.0');
    assert.equal(publishedDesktopRelease([bad]), null);
  }
  assert.equal(publishedDesktopRelease(null), null);
});

test('fetches past non-desktop releases and stops when complete installers are found', async () => {
  const calls = [];
  const result = await fetchDesktopRelease({
    token: 'test-token',
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => calls.length === 1 ? Array(100).fill({ tag_name: 'sdk-v1.0.0' }) : [release()] };
    },
  });
  assert.equal(result.version, '0.6.0');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /page=2$/);
});

test('offline, rate-limited, timed-out, missing and invalid metadata leave usable fallback links', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('timeout'); },
    async () => ({ ok: false, status: 403 }),
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
    async () => ({ ok: true, json: async () => ({ message: 'invalid response' }) }),
    async () => ({ ok: true, json: async () => [] }),
  ]) {
    const result = await fetchDesktopRelease({ fetchImpl, warn() {} });
    assert.equal(result, null);
    const html = renderDesktopRelease(template, result);
    assert.ok(html.includes('Version details are temporarily unavailable'));
    assert.ok(!html.includes('{{DESKTOP_RELEASE}}'));
    assert.equal((html.match(/\/download\/desktop-latest\//g) || []).length, 4);
  }
  const result = await fetchDesktopRelease({ offline: true, fetchImpl: () => assert.fail('offline build used network') });
  assert.equal(result, null);
});

test('built download HTML includes version, UTC date, notes, history and matching installers without JavaScript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fas-desktop-release-'));
  try {
    const fixture = join(dir, 'releases.json');
    const registry = join(dir, 'registry.json');
    writeFileSync(fixture, JSON.stringify([release()]));
    writeFileSync(registry, JSON.stringify({ apps: [] }));
    execFileSync(process.execPath, [join(root, 'build.js')], {
      env: { ...process.env, FAS_OFFLINE: '1', FAS_DESKTOP_RELEASE_PATH: fixture, FAS_REGISTRY_PATH: registry, FAS_DIST: join(dir, 'dist') },
      stdio: 'pipe', timeout: 30_000,
    });
    const html = readFileSync(join(dir, 'dist/download.html'), 'utf8');
    assert.ok(html.includes('Version 0.6.0'));
    assert.ok(html.includes('<time datetime="2026-11-27T15:34:45.000Z">November 27, 2026</time>'));
    assert.ok(html.includes(`${RELEASES}/tag/desktop-v0.6.0">What’s new</a>`));
    assert.ok(html.includes(`${RELEASES}?q=desktop-v">Previous versions</a>`));
    assert.equal((html.match(/\/download\/desktop-v0\.6\.0\//g) || []).length, 4);
    assert.ok(!html.includes('desktop-latest'));
    assert.ok(!html.includes('{{'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OS-specific primary buttons use the same versioned installer URLs as the rendered list', async () => {
  const html = renderDesktopRelease(template, publishedDesktopRelease([release()]));
  const links = Object.fromEntries([...html.matchAll(/href="([^"]+)" data-asset="([^"]+)"/g)].map(([, href, asset]) => [asset, href]));
  for (const [platform, expected] of [['Win32', 'win-x64'], ['Linux x86_64', 'linux-x64'], ['MacIntel', 'mac-arm64']]) {
    const buttons = { children: [], replaceChildren(...children) { this.children = children; } };
    const elements = { 'dl-buttons': buttons, 'dl-detected': {} };
    runInNewContext(readFileSync(join(root, 'download.js'), 'utf8'), {
      navigator: { platform, userAgent: platform, maxTouchPoints: 0 },
      document: {
        getElementById: id => elements[id], createElement: () => ({}),
        querySelector: selector => ({ getAttribute: () => links[selector.match(/"([^"]+)"/)[1]] }),
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(buttons.children[0].href, links[expected]);
    assert.ok(buttons.children.every(button => button.href.includes('/desktop-v0.6.0/')));
  }
});
