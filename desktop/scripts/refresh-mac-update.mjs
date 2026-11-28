// Stapling a DMG changes its bytes. Update the generated updater hashes before publication.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse, stringify } from 'yaml';

export function refreshMacUpdate(directory) {
  const path = join(directory, 'latest-mac.yml');
  const info = parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(info.files) || !info.files.length) throw new Error('Missing Mac update files');
  const metadata = (name) => {
    if (
      typeof name !== 'string' ||
      basename(name) !== name ||
      !/^FreeAppStore-mac-(x64|arm64)\.(zip|dmg)$/.test(name)
    )
      throw new Error('Unexpected Mac update asset');
    const bytes = readFileSync(join(directory, name));
    return { sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length };
  };
  for (const file of info.files) Object.assign(file, metadata(file.url));
  if (info.path) info.sha512 = metadata(info.path).sha512;
  writeFileSync(path, stringify(info));
}
if (process.argv[1]?.endsWith('/refresh-mac-update.mjs'))
  refreshMacUpdate(process.argv[2] ?? 'release');
