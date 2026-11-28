import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import desktop from '../lib/desktop-release.cjs';

const { ASSETS, RELEASES, SIGNING, PROVENANCE, fetchDesktopRelease, renderDesktopRelease } = desktop;
const digest = 'a'.repeat(64);
function proof(version = '0.6.0') {
  return { schemaVersion: 1, version, tag: `desktop-v${version}`, commit: 'b'.repeat(40),
    macOS: { developerId: true, notarized: true, gatekeeperAccepted: true },
    windows: { authenticode: true, timestamped: true, smartScreenVerified: true },
    artifacts: ASSETS.map(name => ({ name, sha256: digest })) };
}
function manifests(releases) {
  return Object.fromEntries((releases || []).map(r => [r.tag_name, proof(r.tag_name.replace('desktop-v', ''))]));
}
function publishedDesktopRelease(releases, evidence = manifests(releases)) {
  return desktop.publishedDesktopRelease(releases, evidence);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const template = readFileSync(join(root, 'download.html'), 'utf8');

function release(version = '0.6.0', overrides = {}) {
  const tag_name = `desktop-v${version}`;
  return {
    tag_name, draft: false, published_at: '2026-11-27T15:34:45Z',
    assets: [...ASSETS, SIGNING, PROVENANCE].map((name, i) => ({ name, id: i + 1, digest: `sha256:${digest}`, state: 'uploaded', size: 123, browser_download_url: `${RELEASES}/download/${tag_name}/${name}` })),
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
    verify: async (manifest, bundle, candidate) => { assert.equal(JSON.parse(manifest).tag, candidate.tag); assert.ok(bundle); return true; },
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.ok(options.signal instanceof AbortSignal);
      if (url.includes('/assets/')) return { ok: true, text: async () => JSON.stringify(proof()) };
      return { ok: true, json: async () => calls.length === 1 ? Array(100).fill({ tag_name: 'sdk-v1.0.0' }) : [release()] };
    },
  });
  assert.equal(result.version, '0.6.0');
  assert.equal(calls.length, 4);
  assert.match(calls[1], /page=2$/);
});

test('offline, rate-limited, timed-out, missing and invalid metadata never promote unsigned fallback links', async () => {
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
    assert.ok(html.includes('Signed desktop downloads are being prepared'));
    assert.ok(!html.includes('{{DESKTOP_RELEASE}}'));
    assert.equal((html.match(/\/download\/desktop-latest\//g) || []).length, 0);
    assert.ok(!html.includes('data-asset='));
    assert.ok(!html.includes('id="dl-buttons"'));
    assert.ok(!html.includes('id="first-launch"'));
  }
  const result = await fetchDesktopRelease({ offline: true, fetchImpl: () => assert.fail('offline build used network') });
  assert.equal(result, null);
});

test('built download HTML includes version, UTC date, notes, history and matching installers without JavaScript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fas-desktop-release-'));
  try {
    const fixture = join(dir, 'releases.json');
    const registry = join(dir, 'registry.json');
    writeFileSync(fixture, JSON.stringify({ releases: [release()], signingManifests: manifests([release()]) }));
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


test('unsigned, unbound or incomplete signing evidence never becomes a download', () => {
  assert.equal(desktop.publishedDesktopRelease([release()]), null);
  for (const invalid of [
    { ...proof(), schemaVersion: 2 }, { ...proof(), tag: 'desktop-v99.0.0' },
    { ...proof(), version: '99.0.0' }, { ...proof(), commit: 'not a commit' },
    { ...proof(), macOS: { ...proof().macOS, notarized: false } },
    { ...proof(), windows: { ...proof().windows, authenticode: false } },
    { ...proof(), artifacts: proof().artifacts.slice(1) },
    { ...proof(), artifacts: proof().artifacts.map(a => ({ ...a, sha256: 'c'.repeat(64) })) },
  ]) assert.equal(publishedDesktopRelease([release()], { 'desktop-v0.6.0': invalid }), null);
  assert.equal(publishedDesktopRelease([release('0.6.0', { assets: release().assets.map(a => ({ ...a, digest: undefined })) })]), null);
});

test('Windows stays unavailable until fresh-download verification; no security bypass instructions remain', () => {
  const pending = { ...proof(), windows: { ...proof().windows, smartScreenVerified: false } };
  const selected = publishedDesktopRelease([release()], { 'desktop-v0.6.0': pending });
  const html = renderDesktopRelease(template, selected);
  assert.ok(html.includes('data-asset="mac-arm64"'));
  assert.ok(html.includes('data-asset="linux-x64"'));
  assert.ok(!html.includes('data-asset="win-x64"'));
  assert.ok(!html.includes('id="windows"'));
  assert.match(html, /Windows download is awaiting installation verification/);
  for (const output of [html, renderDesktopRelease(template, null)]) {
    assert.doesNotMatch(output, /Open Anyway|Run anyway|xattr|com\.apple\.quarantine/);
    assert.doesNotMatch(output, /<!-- (?:VERIFIED|MAC_INSTALL|WINDOWS_INSTALL|LINUX_INSTALL)/);
  }
});

test('installer picker never constructs a button for a withheld platform', async () => {
  const buttons = { children: [], replaceChildren(...children) { this.children = children; } };
  const detected = {};
  runInNewContext(readFileSync(join(root, 'download.js'), 'utf8'), {
    navigator: { platform: 'Win32', userAgent: 'Windows', maxTouchPoints: 0 },
    document: { getElementById: id => id === 'dl-buttons' ? buttons : detected,
      createElement: () => assert.fail('withheld installer became a button'), querySelector: () => null },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(buttons.children.length, 0);
  assert.match(detected.textContent, /being prepared/);
});


test('cryptographic verification binds the manifest to the release workflow and fails closed', () => {
  let verifiedPath;
  const ok = desktop.verifyProvenance('manifest bytes', 'bundle bytes', { tag: 'desktop-v0.7.0' }, (command, args, options) => {
    assert.equal(command, 'gh');
    assert.equal(args[0], 'attestation'); assert.equal(args[1], 'verify');
    verifiedPath = args[2];
    assert.equal(readFileSync(verifiedPath, 'utf8'), 'manifest bytes');
    assert.equal(readFileSync(args[args.indexOf('--bundle') + 1], 'utf8'), 'bundle bytes');
    const identity = new RegExp(args[args.indexOf('--cert-identity-regex') + 1]);
    const prefix = 'https://github.com/freeappstore-online/platform/.github/workflows/desktop-release.yml@';
    assert.ok(identity.test(prefix + 'refs/heads/main'));
    assert.ok(identity.test(prefix + 'refs/tags/desktop-v0.7.0'));
    assert.ok(!identity.test(prefix + 'refs/pull/123/merge'));
    assert.ok(!identity.test(prefix + 'refs/tags/desktop-v0.6.0'));
    assert.equal(args[args.indexOf('--repo') + 1], 'freeappstore-online/platform');
    assert.ok(args.includes('--deny-self-hosted-runners'));
    assert.equal(options.timeout, 20_000);
  });
  assert.equal(ok, true);
  assert.throws(() => readFileSync(verifiedPath));
  assert.equal(desktop.verifyProvenance('forged', 'old bundle', { tag: 'desktop-v0.7.0' }, () => { throw new Error('invalid signature'); }), false);
});

test('a manifest with valid installer hashes but invalid attestation cannot promote downloads', async () => {
  let checks = 0;
  const result = await fetchDesktopRelease({
    fetchImpl: async url => url.includes('/assets/')
      ? { ok: true, text: async () => JSON.stringify(proof()) }
      : { ok: true, json: async () => [release()] },
    verify: () => { checks++; return false; }, warn() {},
  });
  assert.equal(checks, 1); assert.equal(result, null);
});

test('verified Mac and Linux release does not depend on Windows Store enrollment', () => {
  const core = release(); core.assets = core.assets.filter(a => !a.name.endsWith('.exe'));
  const manifest = proof(); manifest.windows = null; manifest.artifacts = manifest.artifacts.filter(a => !a.name.endsWith('.exe'));
  const selected = publishedDesktopRelease([core], { [core.tag_name]: manifest });
  assert.equal(selected.platforms.mac, true); assert.equal(selected.platforms.linux, true); assert.equal(selected.platforms.windows, false);
  const html = renderDesktopRelease(template, selected);
  assert.ok(html.includes('data-asset="mac-arm64"')); assert.ok(!html.includes('data-asset="win-x64"'));
});
