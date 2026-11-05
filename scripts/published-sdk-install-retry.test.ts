import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const helper = readFileSync(new URL('./published-scaffold.sh', import.meta.url), 'utf8');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
function run(mode: string) {
  return spawnSync(
    bash,
    [
      '-c',
      `
set -euo pipefail
FAKE_NOW=1000
PUBLISHED_REGISTRY_DEADLINE=1300
SDK_VERSION=0.16.37
ATTEMPTS=0
MODE='${mode}'
date() { echo "$FAKE_NOW"; }
sleep() { FAKE_NOW=$((FAKE_NOW + $1)); }
timeout() {
  shift
  test "$*" = 'pnpm install --no-frozen-lockfile' || return 2
  ATTEMPTS=$((ATTEMPTS + 1)); echo ATTEMPT
  case "$MODE" in
    eventual) if [ "$ATTEMPTS" -ge 3 ]; then return 0; fi ;;
    unrelated) echo 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/another/-/another-1.tgz: Not Found'; return 1 ;;
    wrongversion) echo 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@freeappstore/sdk/-/sdk-0.16.36.tgz: Not Found'; return 1 ;;
    lifecycle) echo 'ELIFECYCLE'; return 7 ;;
    timeout) return 124 ;;
  esac
  echo 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@freeappstore/sdk/-/sdk-0.16.37.tgz: Not Found'
  return 1
}
${helper}
install_published_scaffold_dependencies
echo CONTINUED
`,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
}

it('waits for the exact selected SDK archive after metadata became visible', () => {
  const result = run('eventual');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.match(/ATTEMPT/g)).toHaveLength(3);
  expect(result.stdout).toContain('CONTINUED');
});

it.each(['unrelated', 'wrongversion', 'lifecycle', 'timeout'])(
  'does not retry %s failures',
  (mode) => {
    const result = run(mode);
    expect(result.status).toBe(mode === 'lifecycle' ? 7 : mode === 'timeout' ? 124 : 1);
    expect(result.stdout.match(/ATTEMPT/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('CONTINUED');
  },
);

it('keeps persistent archive 404s inside the original shared deadline', () => {
  const result = run('missing');
  expect(result.status).toBe(1);
  expect(result.stdout.match(/ATTEMPT/g)).toHaveLength(60);
  expect(result.stdout).toContain('shared five-minute deadline');
});
