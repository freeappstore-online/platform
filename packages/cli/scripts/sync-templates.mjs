import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getTemplateFiles } from '../dist/lib/starter-foundation.js';

const [standaloneRoot, connectedRoot] = process.argv.slice(2);
if (!standaloneRoot || !connectedRoot) {
  throw new Error(
    'Usage: pnpm sync:templates <standalone-repo-checkout> <connected-repo-checkout>',
  );
}

const presets = [
  ['standalone', standaloneRoot],
  ['connected', connectedRoot],
];

for (const [preset, root] of presets) {
  const files = getTemplateFiles(
    { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
    'generic',
    preset,
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  process.stdout.write(`Synchronized ${preset}: ${Object.keys(files).length} canonical files\n`);
}
