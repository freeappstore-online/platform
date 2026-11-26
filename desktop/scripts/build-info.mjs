// Writes dist/build-info.json, the build number and commit the app shows next to its version (#832,
// docs/versioning.md). The release workflow sets FAS_BUILD_NUMBER (its run number); any other build is "dev".
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
const build = process.env.FAS_BUILD_NUMBER || 'dev';
writeFileSync(
  new URL('../dist/build-info.json', import.meta.url),
  `${JSON.stringify({ build, commit })}\n`,
);
