// Download links are promoted only from published releases with bound signing evidence.
// Never read desktop/package.json or fall back to the mutable, possibly unsigned latest alias.
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const RELEASES = 'https://github.com/freeappstore-online/platform/releases';
const API = 'https://api.github.com/repos/freeappstore-online/platform/releases';
const SIGNING = 'FreeAppStore-signing.json';
const PROVENANCE = 'FreeAppStore-provenance.sigstore.json';
const ASSETS = [
  'FreeAppStore-mac-arm64.dmg', 'FreeAppStore-mac-x64.dmg',
  'FreeAppStore-mac-arm64.zip', 'FreeAppStore-mac-x64.zip',
  'FreeAppStore-win-x64.exe', 'FreeAppStore-linux-x86_64.AppImage',
];
const CORE_ASSETS = ASSETS.filter(name => !name.endsWith('.exe'));

function verifyProvenance(manifest, bundle, release, run = execFileSync) {
  const directory = mkdtempSync(join(tmpdir(), 'fas-signing-evidence-'));
  try {
    const artifact = join(directory, SIGNING), proof = join(directory, PROVENANCE);
    writeFileSync(artifact, manifest); writeFileSync(proof, bundle);
    // Only our release workflow on main or this version tag may certify download eligibility.
    const identity = '^https://github\\.com/freeappstore-online/platform/\\.github/workflows/desktop-release\\.yml@refs/(heads/main|tags/' + release.tag.replaceAll('.', '\\.') + ')$';
    run('gh', ['attestation', 'verify', artifact, '--bundle', proof,
      '--repo', 'freeappstore-online/platform', '--cert-identity-regex', identity,
      '--deny-self-hosted-runners'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch { return false; }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function candidates(releases) {
  if (!Array.isArray(releases)) return [];
  return releases.flatMap((release) => {
    const match = /^desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release?.tag_name);
    if (!match || release.draft !== false || !Array.isArray(release.assets)) return [];
    const parts = match[1].split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) return [];
    if (typeof release.published_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(release.published_at)) return [];
    const date = new Date(release.published_at);
    if (!Number.isFinite(date.getTime())) return [];
    const required = [...CORE_ASSETS, SIGNING, PROVENANCE];
    if (release.assets.some(a => a.name === 'FreeAppStore-win-x64.exe')) required.push('FreeAppStore-win-x64.exe');
    if (!required.every(name => release.assets.some(asset =>
      asset.name === name && asset.state === 'uploaded' && asset.size > 0 &&
      asset.browser_download_url === `${RELEASES}/download/${release.tag_name}/${name}`))) return [];
    return [{ version: match[1], tag: release.tag_name, publishedAt: date.toISOString(), parts, assets: release.assets }];
  }).sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
}

function verifiedRelease(release, proof) {
  if (!proof || proof.schemaVersion !== 1 || proof.version !== release.version || proof.tag !== release.tag ||
      !/^[a-f0-9]{40}$/.test(proof.commit) || !Array.isArray(proof.artifacts)) return null;
  // GitHub computes these digests from the uploaded bytes. Replacing an installer invalidates the evidence.
  const present = ASSETS.filter(name => release.assets.some(a => a.name === name));
  if (!present.every(name => {
    const entries = proof.artifacts.filter(a => a.name === name);
    return entries.length === 1 && /^[a-f0-9]{64}$/.test(entries[0].sha256) &&
      release.assets.find(a => a.name === name)?.digest === `sha256:${entries[0].sha256}`;
  })) return null;
  const platforms = {
    mac: proof.macOS?.developerId === true && proof.macOS?.notarized === true && proof.macOS?.gatekeeperAccepted === true,
    windows: present.some(name => name.endsWith('.exe')) && proof.windows?.authenticode === true && proof.windows?.timestamped === true && proof.windows?.smartScreenVerified === true,
    linux: true, // The release pipeline attests all installer hashes, including Linux.
  };
  if (!platforms.mac) return null;
  if (present.some(name => name.endsWith('.exe')) && (proof.windows?.authenticode !== true || proof.windows?.timestamped !== true)) return null;
  return { version: release.version, tag: release.tag, publishedAt: release.publishedAt, parts: release.parts, platforms };
}

function publishedDesktopRelease(releases, signingManifests = {}) {
  for (const release of candidates(releases)) {
    const verified = verifiedRelease(release, signingManifests[release.tag]);
    if (verified) return verified;
  }
  return null;
}

async function fetchDesktopRelease({ token = '', offline = false, fetchImpl = fetch, warn = console.warn, verify = verifyProvenance } = {}) {
  if (offline) return null;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'freeappstore-build' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const signal = AbortSignal.timeout(15_000);
  try {
    for (let page = 1; page <= 5; page++) {
      const response = await fetchImpl(`${API}?per_page=100&page=${page}`, { headers, signal });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const releases = await response.json();
      if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid release list');
      for (const release of candidates(releases)) {
        const asset = release.assets.find(a => a.name === SIGNING);
        if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.size > 64_000) continue;
        // Fixed API origin: never send a GitHub token to a URL supplied by release metadata.
        const evidence = await fetchImpl(`${API}/assets/${asset.id}`, {
          headers: { ...headers, Accept: 'application/octet-stream' }, signal,
        });
        if (!evidence.ok) continue;
        const raw = await evidence.text();
        if (raw.length > 64_000) continue;
        let proof;
        try { proof = JSON.parse(raw); } catch { continue; }
        const verified = verifiedRelease(release, proof);
        if (!verified) continue;
        const attestation = release.assets.find(a => a.name === PROVENANCE);
        if (!Number.isSafeInteger(attestation.id) || attestation.id <= 0 || attestation.size > 8_000_000) continue;
        const bundleResponse = await fetchImpl(`${API}/assets/${attestation.id}`, {
          headers: { ...headers, Accept: 'application/octet-stream' }, signal,
        });
        if (!bundleResponse.ok) continue;
        const bundle = await bundleResponse.text();
        if (bundle.length <= 8_000_000 && await verify(raw, bundle, release)) return verified;
      }
      if (releases.length < 100) break;
    }
    warn('No verified signed desktop release found; download links are withheld.');
  } catch {
    warn('Desktop signing evidence unavailable; download links are withheld.');
  }
  return null;
}

function block(html, name, keep) {
  return html.replace(new RegExp(`<!-- ${name}_START -->([\\s\\S]*?)<!-- ${name}_END -->`, 'g'), (_, inner) => keep ? inner : '');
}

function renderDesktopRelease(html, release) {
  let details = 'Signed desktop downloads are being prepared. You can keep using <a href="/">all apps in your browser</a>.';
  for (const name of ['VERIFIED_PRIMARY', 'VERIFIED_DOWNLOADS', 'VERIFIED_INSTALL']) html = block(html, name, !!release);
  html = html.replace('{{DESKTOP_BADGE}}', release ? 'Verified desktop downloads' : 'Desktop downloads coming soon');
  if (release) {
    const date = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(release.publishedAt));
    details = `<strong>Version ${release.version}</strong> · Released <time datetime="${release.publishedAt}">${date}</time> · <a href="${RELEASES}/tag/${release.tag}">What’s new</a>`;
    for (const [platform, marker, asset] of [['mac', 'MAC_INSTALL', 'mac-'], ['windows', 'WINDOWS_INSTALL', 'win-'], ['linux', 'LINUX_INSTALL', 'linux-']]) {
      html = block(html, marker, release.platforms[platform]);
      if (!release.platforms[platform]) html = html.replace(new RegExp(`<li><a[^>]+data-asset="${asset}[^"]+"[\\s\\S]*?<\\/li>`, 'g'), '');
    }
    if (!release.platforms.windows) details += ' · Windows download is awaiting installation verification.';
    html = html.replaceAll(`${RELEASES}/download/desktop-latest/`, `${RELEASES}/download/${release.tag}/`)
      .replaceAll(`${RELEASES}/tag/desktop-latest`, `${RELEASES}/tag/${release.tag}`);
  }
  return html.replace('{{DESKTOP_RELEASE}}', () => details);
}

module.exports = { ASSETS, CORE_ASSETS, RELEASES, SIGNING, PROVENANCE, verifyProvenance, publishedDesktopRelease, fetchDesktopRelease, renderDesktopRelease };
