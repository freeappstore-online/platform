import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
// @ts-expect-error The release helper is plain Node ESM, outside the app's TypeScript project.
import { refreshMacUpdate } from '../../scripts/refresh-mac-update.mjs';
// @ts-expect-error The release helper is plain Node ESM, outside the app's TypeScript project.
import { installerNames, writeSigningManifest } from '../../scripts/write-signing-manifest.mjs';

it('updates every Mac installer hash after stapling without changing the release version (#857)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fas-release-'));
  try {
    const files = [
      'FreeAppStore-mac-x64.zip',
      'FreeAppStore-mac-arm64.zip',
      'FreeAppStore-mac-x64.dmg',
      'FreeAppStore-mac-arm64.dmg',
    ];
    for (const file of files) writeFileSync(join(dir, file), `stapled ${file}`);
    writeFileSync(
      join(dir, 'latest-mac.yml'),
      stringify({
        version: '1.2.3',
        path: files[0],
        sha512: 'old',
        files: files.map((url) => ({ url, sha512: 'old', size: 1 })),
      }),
    );
    refreshMacUpdate(dir);
    const info = parse(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'));
    expect(info.version).toBe('1.2.3');
    for (const file of info.files) {
      const bytes = readFileSync(join(dir, file.url));
      expect(file).toMatchObject({
        sha512: createHash('sha512').update(bytes).digest('base64'),
        size: bytes.length,
      });
    }
    expect(info.sha512).toBe(info.files[0].sha512);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('binds release identity and verified platforms to final hashes without asserting SmartScreen trust (#857)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fas-signing-'));
  try {
    for (const name of installerNames) writeFileSync(join(dir, name), `signed ${name}`);
    const mac = {
      schemaVersion: 1,
      developerId: true,
      notarized: true,
      gatekeeperAccepted: true,
      architectures: ['x64', 'arm64'],
    };
    writeFileSync(join(dir, 'mac-signing-verification.json'), JSON.stringify(mac));
    writeFileSync(
      join(dir, 'windows-signing-verification.json'),
      JSON.stringify({
        schemaVersion: 1,
        authenticode: true,
        timestamped: true,
        smartScreenVerified: true,
      }),
    );
    const commit = 'a'.repeat(40);
    const result = writeSigningManifest(dir, '1.2.3', 'desktop-v1.2.3', commit);
    expect(result.commit).toBe(commit);
    expect(result.windows.smartScreenVerified).toBe(false);
    expect(result.artifacts).toHaveLength(6);
    for (const artifact of result.artifacts)
      expect(artifact.sha256).toBe(
        createHash('sha256')
          .update(readFileSync(join(dir, artifact.name)))
          .digest('hex'),
      );
    expect(() => writeSigningManifest(dir, '1.2.3', 'desktop-v1.2.4', commit)).toThrow(
      'Invalid release identity',
    );
    writeFileSync(
      join(dir, 'mac-signing-verification.json'),
      JSON.stringify({ ...mac, notarized: false }),
    );
    expect(() => writeSigningManifest(dir, '1.2.3', 'desktop-v1.2.3', commit)).toThrow(
      'Mac verification is incomplete',
    );
    writeFileSync(join(dir, 'mac-signing-verification.json'), JSON.stringify(mac));
    rmSync(join(dir, 'FreeAppStore-win-x64.exe'));
    expect(() => writeSigningManifest(dir, '1.2.3', 'desktop-v1.2.3', commit)).toThrow(
      'Windows verification is incomplete',
    );
    rmSync(join(dir, 'windows-signing-verification.json'));
    const storeWindows = writeSigningManifest(dir, '1.2.3', 'desktop-v1.2.3', commit);
    expect(storeWindows.windows).toBe(null);
    expect(storeWindows.artifacts).toHaveLength(5);
    rmSync(join(dir, installerNames[5]));
    expect(() => writeSigningManifest(dir, '1.2.3', 'desktop-v1.2.3', commit)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
