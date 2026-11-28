import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  draftSnapshot,
  identity,
  LINUX,
  MAC,
  macUpdater,
  manifest,
  REPO,
  TEAM,
} from './cloud-release.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expected = identity('1.0.0', '2026112801', 'a'.repeat(40));
function fixture() {
  const release = {
    id: 7,
    draft: true,
    tag_name: expected.tag,
    assets: MAC.map((name, i) => ({
      name,
      id: i + 10,
      state: 'uploaded',
      size: 3,
      digest: `sha256:${hash('zip')}`,
      browser_download_url: `https://github.com/${REPO}/releases/download/${expected.tag}/${name}`,
    })),
  };
  return { release, state: draftSnapshot(release, expected) };
}

test('release identity rejects shell/ref injection and development build numbers', () => {
  for (const [version, build, commit] of [
    ['1.0.0;echo bad', '1', expected.commit],
    ['01.0.0', '1', expected.commit],
    ['1.0.0', 'dev', expected.commit],
    ['1.0.0', '0', expected.commit],
    ['1.0.0', '1\nextra=bad', expected.commit],
    ['1.0.0', '1', 'main'],
  ])
    assert.throws(() => identity(version, build, commit));
  assert.equal(expected.build, '2026112801');
});

test('draft snapshot binds only two exact immutable Mac asset IDs, sizes and SHA256 digests', () => {
  const { release, state } = fixture();
  assert.equal(state.assets.length, 2);
  for (const bad of [
    { ...release, draft: false },
    { ...release, tag_name: 'desktop-latest' },
    { ...release, assets: release.assets.slice(1) },
    { ...release, assets: [...release.assets, release.assets[0]] },
    { ...release, assets: release.assets.map((a) => ({ ...a, digest: null })) },
    {
      ...release,
      assets: release.assets.map((a) => ({
        ...a,
        browser_download_url: 'https://foreign.invalid/file.zip',
      })),
    },
  ])
    assert.throws(() => draftSnapshot(bad, expected));
});

test('manifest requires independently verified receipts and exact final artifact bytes', () => {
  const out = mkdtempSync(join(tmpdir(), 'cloud-proof-'));
  try {
    const { state } = fixture();
    MAC.forEach((name) => {
      writeFileSync(join(out, name), 'zip');
    });
    writeFileSync(join(out, LINUX), 'linux');
    const receipts = MAC.map((name, i) => ({
      ...expected,
      name,
      team: TEAM,
      arch: i ? 'arm64' : 'x64',
      sha256: hash('zip'),
      developerId: true,
      notarized: true,
      gatekeeperAccepted: true,
      sourceDistVerified: true,
    }));
    const linux = { ...expected, sha256: hash('linux') };
    const proof = manifest(state, receipts, linux, out);
    assert.equal(proof.windows, null);
    assert.deepEqual(
      proof.artifacts.map((a) => a.name),
      [...MAC, LINUX],
    );
    for (const field of ['developerId', 'notarized', 'gatekeeperAccepted', 'sourceDistVerified'])
      assert.throws(() =>
        manifest(state, [{ ...receipts[0], [field]: false }, receipts[1]], linux, out),
      );
    assert.throws(() =>
      manifest(state, [{ ...receipts[0], team: 'OTHERTEAM' }, receipts[1]], linux, out),
    );
    assert.throws(() => manifest(state, receipts, { ...linux, commit: 'b'.repeat(40) }, out));
    writeFileSync(join(out, MAC[0]), 'tampered');
    assert.throws(() => manifest(state, receipts, linux, out));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('Mac updater uses final signed ZIP hashes for each architecture and no DMG fallback', () => {
  const out = mkdtempSync(join(tmpdir(), 'cloud-updater-'));
  try {
    MAC.forEach((name, i) => {
      writeFileSync(join(out, name), `signed-${i}`);
    });
    const updater = macUpdater(expected, out);
    assert.equal(updater.version, '1.0.0');
    assert.deepEqual(
      updater.files.map((f) => f.url),
      MAC,
    );
    updater.files.forEach((f, i) => {
      assert.equal(f.size, Buffer.byteLength(`signed-${i}`));
      assert.equal(f.sha512, createHash('sha512').update(`signed-${i}`).digest('base64'));
    });
    assert.equal(updater.path, MAC[0]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

const createZip = `import json,sys,zipfile,stat\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for e in json.load(sys.stdin):\n  i=zipfile.ZipInfo(e['name']);i.create_system=3;i.external_attr=((stat.S_IFLNK|0o777) if e.get('link') else (stat.S_IFREG|0o644))<<16;z.writestr(i,e.get('data',''))`;
function checkZip(entries) {
  const out = mkdtempSync(join(tmpdir(), 'cloud-zip-'));
  try {
    const path = join(out, 'app.zip');
    execFileSync('python3', ['-c', createZip, path], {
      input: JSON.stringify(entries),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return execFileSync('python3', [join(dir, 'cloud-release-zip.py'), path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
const info = { name: 'FreeAppStore.app/Contents/Info.plist', data: 'fixture' };
test('ZIP preflight permits app metadata and internal framework symlinks', () => {
  assert.match(
    checkZip([
      info,
      { name: 'FreeAppStore.app/Contents/Frameworks/Foo/Versions/A/Foo', data: 'binary' },
      { name: 'FreeAppStore.app/Contents/Frameworks/Foo/Foo', link: true, data: 'Versions/A/Foo' },
      { name: '__MACOSX/FreeAppStore.app/Contents/._Info.plist', data: 'fork' },
    ]),
    /Validated/,
  );
});
test('ZIP preflight rejects traversal, duplicates, escaping or dangling links and writes through links', () => {
  for (const entries of [
    [info, { name: '../outside', data: 'bad' }],
    [info, { name: '/tmp/outside', data: 'bad' }],
    [info, { name: 'FreeAppStore.app/../outside', data: 'bad' }],
    [info, info],
    [info, { name: 'FreeAppStore.app/Contents/link', link: true, data: '../../../outside' }],
    [info, { name: 'FreeAppStore.app/Contents/link', link: true, data: '/etc/passwd' }],
    [info, { name: 'FreeAppStore.app/Contents/link', link: true, data: 'missing' }],
    [
      info,
      { name: 'FreeAppStore.app/Contents/link', link: true, data: 'Info.plist' },
      { name: 'FreeAppStore.app/Contents/link/evil', data: 'bad' },
    ],
  ])
    assert.throws(() => checkZip(entries));
});

test('ZIP preflight rejects casefold and Unicode aliases, including implicit directories and symlinks', () => {
  for (const entries of [
    [info, { name: 'FreeAppStore.app/Contents/INFO.PLIST', data: 'replacement' }],
    [
      info,
      { name: 'FreeAppStore.app/Contents/Café', data: 'one' },
      { name: 'FreeAppStore.app/Contents/Cafe\u0301', data: 'two' },
    ],
    [
      info,
      { name: 'FreeAppStore.app/Contents/Foo/a', data: 'one' },
      { name: 'FreeAppStore.app/Contents/foo/b', data: 'two' },
    ],
    [
      info,
      { name: 'FreeAppStore.app/Contents/Link', link: true, data: 'Info.plist' },
      { name: 'FreeAppStore.app/Contents/link/evil', data: 'bad' },
    ],
    [
      info,
      { name: 'FreeAppStore.app/Contents/Café', link: true, data: 'Info.plist' },
      { name: 'FreeAppStore.app/Contents/Cafe\u0301/evil', data: 'bad' },
    ],
    [info, { name: 'FreeAppStore.app/Contents/Link', link: true, data: 'lInK' }],
  ])
    assert.throws(() => checkZip(entries));
  // A link target may use the filesystem's equivalent spelling, but cannot evade cycle checks.
  assert.match(
    checkZip([info, { name: 'FreeAppStore.app/Contents/link', link: true, data: 'INFO.PLIST' }]),
    /Validated/,
  );
});

test('promotion workflow is main-or-exact-tag-only and cannot publish before source tests and both verifiers pass', () => {
  const workflow = readFileSync(
    join(dir, '../../.github/workflows/desktop-cloud-release.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /if: github.ref == 'refs\/heads\/main' \|\| github.ref == format\('refs\/tags\/desktop-v\{0}', inputs.version\)/,
  );
  assert.match(workflow, /needs: \[resolve, test, verify-mac, linux\]/);
  assert.match(workflow, /ref: \$\{\{ needs.resolve.outputs.commit }}/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /subject-path: out\/FreeAppStore-\*/);
});
