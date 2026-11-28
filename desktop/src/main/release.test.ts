import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
// @ts-expect-error The release helper is plain Node ESM, outside the app's TypeScript project.
import { refreshMacUpdate } from '../../scripts/refresh-mac-update.mjs';

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
