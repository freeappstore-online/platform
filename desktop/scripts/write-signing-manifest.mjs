// Publish only evidence emitted by the platform verifiers, bound to the final installer bytes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const installerNames = [
  'FreeAppStore-mac-x64.dmg',
  'FreeAppStore-mac-arm64.dmg',
  'FreeAppStore-mac-x64.zip',
  'FreeAppStore-mac-arm64.zip',
  'FreeAppStore-win-x64.exe',
  'FreeAppStore-linux-x86_64.AppImage',
];

export function writeSigningManifest(directory, version, tag, commit) {
  if (
    !/^\d+\.\d+\.\d+$/.test(version) ||
    tag !== `desktop-v${version}` ||
    !/^[a-f0-9]{40}$/.test(commit)
  )
    throw new Error('Invalid release identity');
  const receipt = (platform) =>
    JSON.parse(readFileSync(join(directory, `${platform}-signing-verification.json`), 'utf8'));
  const mac = receipt('mac');
  if (
    mac.schemaVersion !== 1 ||
    mac.developerId !== true ||
    mac.notarized !== true ||
    mac.gatekeeperAccepted !== true ||
    !Array.isArray(mac.architectures) ||
    mac.architectures.join(',') !== 'x64,arm64'
  )
    throw new Error('Mac verification is incomplete');
  const hasWindows = existsSync(join(directory, 'FreeAppStore-win-x64.exe'));
  if (hasWindows || existsSync(join(directory, 'windows-signing-verification.json'))) {
    const win = receipt('windows');
    if (
      !hasWindows ||
      win.schemaVersion !== 1 ||
      win.authenticode !== true ||
      win.timestamped !== true
    )
      throw new Error('Windows verification is incomplete');
  }
  const artifacts = installerNames
    .filter((name) => hasWindows || name !== 'FreeAppStore-win-x64.exe')
    .map((name) => {
      const bytes = readFileSync(join(directory, name));
      if (!bytes.length) throw new Error(`Empty installer: ${name}`);
      return { name, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
  const manifest = {
    schemaVersion: 1,
    version,
    tag,
    commit,
    macOS: { developerId: true, notarized: true, gatekeeperAccepted: true },
    // Authenticode alone does not establish SmartScreen reputation. Never infer this from a valid signature.
    windows: hasWindows
      ? { authenticode: true, timestamped: true, smartScreenVerified: false }
      : null,
    artifacts,
  };
  writeFileSync(
    join(directory, 'FreeAppStore-signing.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

if (process.argv[1]?.endsWith('/write-signing-manifest.mjs'))
  writeSigningManifest(...process.argv.slice(2));
