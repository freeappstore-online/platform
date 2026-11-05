#!/usr/bin/env bash
set -euo pipefail
version="$1"
node --input-type=module - "$version" <<'JS'
import fs from 'node:fs';
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid SDK release version');
const metadata = JSON.parse(fs.readFileSync('packages/sdk/package.json', 'utf8'));
if (metadata.version !== version) throw new Error('SDK release metadata does not match selected version');
const path = 'packages/sdk/src/logger.ts';
const source = fs.readFileSync(path, 'utf8');
if ((source.match(/export const SDK_VERSION = '[^']*';/g) ?? []).length !== 1) throw new Error('Expected one SDK version export');
fs.writeFileSync(path, source.replace(/export const SDK_VERSION = '[^']*';/, `export const SDK_VERSION = '${version}';`));
JS
# Publication must pack the newly versioned runtime, not the earlier build output.
pnpm --dir packages/sdk run build
node --input-type=module - "$version" <<'JS'
const { SDK_VERSION } = await import('./packages/sdk/dist/logger.js');
if (SDK_VERSION !== process.argv[2]) throw new Error('Built SDK version is stale; refusing publication');
JS
