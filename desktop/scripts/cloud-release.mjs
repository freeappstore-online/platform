// Promotion of externally cloud-signed Mac bundles. Run only from the trusted main workflow checkout.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = 'freeappstore-online/platform';
export const TEAM = '55DT52UQXE';
export const MAC = ['FreeAppStore-mac-x64.zip', 'FreeAppStore-mac-arm64.zip'];
export const LINUX = 'FreeAppStore-linux-x86_64.AppImage';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
const gh = (args, options) => run('gh', args, options);
const api = (path) => JSON.parse(gh(['api', `repos/${REPO}/${path}`]));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function identity(version, build, commit) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    !version.split('.').every((v) => Number.isSafeInteger(Number(v))) ||
    !/^[1-9]\d{0,14}$/.test(String(build)) ||
    !Number.isSafeInteger(Number(build)) ||
    !/^[a-f0-9]{40}$/.test(commit)
  )
    throw new Error('Invalid release identity');
  return { version, build: String(build), commit, tag: `desktop-v${version}` };
}

// GitHub's tag endpoint excludes draft releases; discover the draft through the authenticated list.
export function findRelease(tag, request = api) {
  for (let page = 1; page <= 10; page++) {
    const releases = request(`releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Invalid release list');
    const matches = releases.filter((release) => release?.tag_name === tag);
    if (matches.length > 1) throw new Error('Ambiguous release tag');
    if (matches.length === 1) return matches[0];
    if (releases.length < 100) break;
  }
  throw new Error('Draft release not found');
}

export function validateDispatch(expected, ref, verifierCommit) {
  if (!/^[a-f0-9]{40}$/.test(verifierCommit)) throw new Error('Invalid verifier commit');
  if (ref === 'refs/heads/main') return;
  if (ref !== `refs/tags/${expected.tag}` || verifierCommit !== expected.commit)
    throw new Error('Only trusted main or the exact source tag may verify a release');
}

function draftAssetUrl(url, tag, name) {
  const prefix = `https://github.com/${REPO}/releases/download/`;
  if (typeof url !== 'string' || !url.startsWith(prefix) || !url.endsWith(`/${name}`)) return false;
  const releasePart = url.slice(prefix.length, -name.length - 1);
  return releasePart === tag || /^untagged-[a-f0-9]{20}$/.test(releasePart);
}

export function draftSnapshot(release, expected) {
  if (
    release?.draft !== true ||
    release.tag_name !== expected.tag ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    !Array.isArray(release.assets) ||
    release.assets.length !== MAC.length
  )
    throw new Error('Expected a draft containing only both Mac ZIPs');
  const assets = MAC.map((name) => {
    const matches = release.assets.filter((asset) => asset?.name === name);
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > 1_500_000_000 ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      !draftAssetUrl(asset.browser_download_url, expected.tag, name)
    )
      throw new Error('Invalid or unbound Mac release asset');
    return { name, id: asset.id, size: asset.size, digest: asset.digest };
  });
  return { ...expected, releaseId: release.id, assets };
}

function assertCurrentSource(state, source) {
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: source });
  if (
    commit !== state.commit ||
    json(join(source, 'desktop/package.json')).version !== state.version
  )
    throw new Error('Checked-out source differs from release identity');
}

function assertTag(state, source) {
  const commit = run('git', ['rev-parse', `refs/tags/${state.tag}^{commit}`], { cwd: source });
  if (commit !== state.commit) throw new Error('Release tag moved');
}

function assertBytes(path, asset) {
  const bytes = readFileSync(path);
  if (bytes.length !== asset.size || `sha256:${sha(bytes)}` !== asset.digest)
    throw new Error('Release asset bytes changed');
  return bytes;
}

export function manifest(state, macReceipts, linuxReceipt, directory) {
  for (const [i, name] of MAC.entries()) {
    const r = macReceipts[i];
    const asset = state.assets.find((a) => a.name === name);
    if (
      !r ||
      r.version !== state.version ||
      r.build !== state.build ||
      r.commit !== state.commit ||
      r.name !== name ||
      r.sha256 !== asset.digest.slice(7) ||
      r.team !== TEAM ||
      r.arch !== (i === 0 ? 'x64' : 'arm64') ||
      r.developerId !== true ||
      r.notarized !== true ||
      r.gatekeeperAccepted !== true ||
      r.sourceDistVerified !== true
    )
      throw new Error('Mac verification receipt mismatch');
    assertBytes(join(directory, name), asset);
  }
  const linuxBytes = readFileSync(join(directory, LINUX));
  if (
    !linuxReceipt ||
    linuxReceipt.commit !== state.commit ||
    linuxReceipt.version !== state.version ||
    linuxReceipt.build !== state.build ||
    linuxReceipt.sha256 !== sha(linuxBytes) ||
    !linuxBytes.length
  )
    throw new Error('Linux build receipt mismatch');
  return {
    schemaVersion: 1,
    verification: {
      verifierCommit: state.verifierCommit,
      sourceScope: 'rebuilt-dist-package-build-identity',
      nativeDependencies: 'signature-integrity-only',
    },
    version: state.version,
    tag: state.tag,
    commit: state.commit,
    macOS: { developerId: true, notarized: true, gatekeeperAccepted: true },
    windows: null,
    artifacts: [...MAC, LINUX].map((name) => ({
      name,
      sha256: sha(readFileSync(join(directory, name))),
    })),
  };
}

export function macUpdater(state, directory) {
  const files = MAC.map((name) => {
    const b = readFileSync(join(directory, name));
    return { url: name, sha512: sha(b, 'sha512', 'base64'), size: b.length };
  });
  // JSON is also YAML; electron-updater reads this using its YAML parser.
  return {
    version: state.version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: new Date().toISOString(),
  };
}

function filesUnder(root, prefix = '') {
  return readdirSync(join(root, prefix))
    .sort()
    .flatMap((name) => {
      const path = prefix ? `${prefix}/${name}` : name;
      const s = lstatSync(join(root, path));
      if (s.isSymbolicLink()) throw new Error('Unexpected source dist symlink');
      return s.isDirectory() ? filesUnder(root, path) : [path];
    });
}

function verifyMac(state, arch, directory, source) {
  if (!['x64', 'arm64'].includes(arch) || process.platform !== 'darwin')
    throw new Error('Mac verification requires macOS and a supported architecture');
  assertCurrentSource(state, source);
  const name = `FreeAppStore-mac-${arch}.zip`;
  const asset = state.assets.find((a) => a.name === name);
  const archive = resolve(directory, name);
  assertBytes(archive, asset);
  run('python3', [join(scriptDir, 'cloud-release-zip.py'), archive]);
  const temp = mkdtempSync(join(tmpdir(), 'fas-cloud-verify-'));
  try {
    run('/usr/bin/ditto', ['-x', '-k', archive, temp]);
    const app = join(temp, 'FreeAppStore.app');
    const plist = JSON.parse(
      run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]),
    );
    if (
      plist.CFBundleIdentifier !== 'online.freeappstore.desktop' ||
      plist.CFBundleShortVersionString !== state.version ||
      plist.CFBundleVersion !== state.version
    )
      throw new Error('Unexpected app bundle identity');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    // codesign writes its successful display output to stderr. Never run the uploaded executable.
    const signature = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', app], {
      encoding: 'utf8',
    });
    if (signature.status !== 0) throw new Error('Cannot read code signature');
    const detail = signature.stderr;
    if (
      !detail.includes(`TeamIdentifier=${TEAM}`) ||
      !/^Authority=Developer ID Application:/m.test(detail) ||
      !/flags=.*\bruntime\b/.test(detail) ||
      /flags=.*\badhoc\b/.test(detail)
    )
      throw new Error('Developer ID / hardened runtime verification failed');
    const arches = run('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS/FreeAppStore')]);
    if (arches !== (arch === 'x64' ? 'x86_64' : 'arm64'))
      throw new Error('Wrong executable architecture');
    if (!/^assessments enabled$/m.test(run('/usr/sbin/spctl', ['--status'])))
      throw new Error('Gatekeeper assessments are disabled');
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    run('/usr/bin/xcrun', ['stapler', 'validate', '-v', app]);
    const builderRequire = createRequire(
      realpathSync(join(source, 'desktop/node_modules/electron-builder/package.json')),
    );
    const require = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
    const asar = require('@electron/asar');
    const asarPath = join(app, 'Contents/Resources/app.asar');
    const packageInfo = JSON.parse(asar.extractFile(asarPath, 'package.json'));
    const buildInfo = JSON.parse(asar.extractFile(asarPath, 'dist/build-info.json'));
    const shortCommit = run('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: source });
    if (
      packageInfo.version !== state.version ||
      buildInfo.build !== state.build ||
      buildInfo.commit !== shortCommit
    )
      throw new Error('Packaged version/build/source mismatch');
    const expected = filesUnder(join(source, 'desktop/dist'));
    const actual = asar
      .listPackage(asarPath)
      .filter((path) => path.startsWith('/dist/') && !asar.statFile(asarPath, path.slice(1)).files)
      .map((path) => path.slice('/dist/'.length))
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
      throw new Error('Packaged dist file list differs from rebuilt source');
    for (const path of expected) {
      if (
        sha(readFileSync(join(source, 'desktop/dist', path))) !==
        sha(asar.extractFile(asarPath, `dist/${path}`))
      )
        throw new Error(`Packaged dist differs from rebuilt source: ${path}`);
    }
    save(join(directory, `mac-${arch}-verification.json`), {
      ...state,
      assets: undefined,
      releaseId: undefined,
      name,
      arch,
      team: TEAM,
      sha256: asset.digest.slice(7),
      developerId: true,
      notarized: true,
      gatekeeperAccepted: true,
      sourceDistVerified: true,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'resolve') {
    const [version, build, output] = args;
    // Validate before constructing any ref or API path.
    const provisional = identity(version, build, '0'.repeat(40));
    const commit = run('git', ['rev-parse', `refs/tags/${provisional.tag}^{commit}`]);
    const verifierCommit = run('git', ['rev-parse', 'HEAD']);
    const expected = { ...identity(version, build, commit), verifierCommit };
    validateDispatch(expected, process.env.GITHUB_REF || 'refs/heads/main', verifierCommit);
    run('git', ['merge-base', '--is-ancestor', commit, 'origin/main']);
    const pkg = JSON.parse(run('git', ['show', `${commit}:desktop/package.json`]));
    if (pkg.version !== version) throw new Error('Tag package version differs');
    save(output, draftSnapshot(findRelease(expected.tag), expected));
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\ntag=${expected.tag}\n`, {
        flag: 'a',
      });
  } else if (command === 'download') {
    const [statePath, arch, directory] = args;
    const state = json(statePath);
    identity(state.version, state.build, state.commit);
    if (!['x64', 'arm64'].includes(arch)) throw new Error('Invalid architecture');
    const asset = state.assets.find((a) => a.name === `FreeAppStore-mac-${arch}.zip`);
    if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0)
      throw new Error('Missing asset');
    mkdirSync(directory, { recursive: true });
    const bytes = execFileSync(
      'gh',
      [
        'api',
        `repos/${REPO}/releases/assets/${asset.id}`,
        '-H',
        'Accept: application/octet-stream',
      ],
      { maxBuffer: 1_500_000_000 },
    );
    const target = join(directory, asset.name);
    writeFileSync(target, bytes);
    assertBytes(target, asset);
  } else if (command === 'verify-mac') {
    verifyMac(json(args[0]), args[1], args[2], resolve(args[3]));
  } else if (command === 'verify-linux') {
    const [statePath, directory, source] = args;
    const state = json(statePath);
    assertCurrentSource(state, source);
    const info = json(join(source, 'desktop/dist/build-info.json'));
    if (
      info.build !== state.build ||
      info.commit !== run('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: source })
    )
      throw new Error('Linux build identity differs');
    const bytes = readFileSync(join(directory, LINUX));
    if (!bytes.length) throw new Error('Missing Linux installer');
    save(join(directory, 'linux-verification.json'), {
      version: state.version,
      build: state.build,
      commit: state.commit,
      sha256: sha(bytes),
    });
  } else if (command === 'prepare') {
    const [statePath, directory] = args;
    const state = json(statePath);
    identity(state.version, state.build, state.commit);
    const proof = manifest(
      state,
      MAC.map((_, i) => json(join(directory, `mac-${i ? 'arm64' : 'x64'}-verification.json`))),
      json(join(directory, 'linux-verification.json')),
      directory,
    );
    save(join(directory, 'FreeAppStore-signing.json'), proof);
    save(join(directory, 'latest-mac.yml'), macUpdater(state, directory));
    const linux = readFileSync(join(directory, LINUX));
    save(join(directory, 'latest-linux.yml'), {
      version: state.version,
      files: [{ url: LINUX, sha512: sha(linux, 'sha512', 'base64'), size: linux.length }],
      path: LINUX,
      sha512: sha(linux, 'sha512', 'base64'),
      releaseDate: new Date().toISOString(),
    });
  } else if (command === 'publish') {
    const [statePath, directory] = args;
    const state = json(statePath);
    identity(state.version, state.build, state.commit);
    run('git', ['fetch', '--force', 'origin', `refs/tags/${state.tag}:refs/tags/${state.tag}`]);
    assertTag(state, process.cwd());
    const current = draftSnapshot(api(`releases/${state.releaseId}`), state);
    if (
      JSON.stringify(current.assets) !== JSON.stringify(state.assets) ||
      current.releaseId !== state.releaseId
    )
      throw new Error('Draft changed during verification');
    manifest(
      state,
      MAC.map((_, i) => json(join(directory, `mac-${i ? 'arm64' : 'x64'}-verification.json`))),
      json(join(directory, 'linux-verification.json')),
      directory,
    );
    const publishNames = [
      ...MAC,
      LINUX,
      'FreeAppStore-signing.json',
      'FreeAppStore-provenance.sigstore.json',
      'latest-mac.yml',
      'latest-linux.yml',
    ];
    for (const name of publishNames)
      if (!readFileSync(join(directory, name)).length) throw new Error(`Missing ${name}`);
    // Re-upload only the exact bytes verified in this run, then compare every published digest before promotion.
    gh([
      'release',
      'upload',
      state.tag,
      ...publishNames.map((name) => join(directory, name)),
      '--clobber',
      '--repo',
      REPO,
    ]);
    const uploaded = api(`releases/${state.releaseId}`);
    if (
      uploaded.draft !== true ||
      uploaded.tag_name !== state.tag ||
      uploaded.assets.length !== publishNames.length
    )
      throw new Error('Draft state or asset set changed during upload');
    for (const name of publishNames) {
      const a = uploaded.assets.filter((a) => a.name === name);
      if (a.length !== 1 || a[0].digest !== `sha256:${sha(readFileSync(join(directory, name)))}`)
        throw new Error('Uploaded release digest differs');
    }
    run('git', ['fetch', '--force', 'origin', `refs/tags/${state.tag}:refs/tags/${state.tag}`]);
    assertTag(state, process.cwd());
    gh([
      'release',
      'edit',
      state.tag,
      '--draft=false',
      '--latest',
      '--title',
      `FreeAppStore desktop ${state.version}`,
      '--notes',
      'Developer ID signed, notarized Mac ZIPs and a Linux AppImage with verified build provenance. Windows distribution is pending.',
      '--repo',
      REPO,
    ]);
    const published = api(`releases/${state.releaseId}`);
    if (published.draft !== false || !published.published_at)
      throw new Error('Release publication not verified');
    // Do not change Windows assets or latest.yml. Mac and Linux update metadata follows the verified installers.
    gh([
      'release',
      'upload',
      'desktop-latest',
      ...[...MAC, LINUX, 'FreeAppStore-signing.json', 'FreeAppStore-provenance.sigstore.json'].map(
        (name) => join(directory, name),
      ),
      '--clobber',
      '--repo',
      REPO,
    ]);
    gh([
      'release',
      'upload',
      'desktop-latest',
      ...['latest-mac.yml', 'latest-linux.yml'].map((name) => join(directory, name)),
      '--clobber',
      '--repo',
      REPO,
    ]);
    console.log(`Published and verified ${state.tag}, commit ${state.commit}`);
  } else throw new Error('Unknown cloud release command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
