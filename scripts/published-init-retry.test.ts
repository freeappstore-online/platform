import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const helper = readFileSync(new URL('./published-scaffold.sh', import.meta.url), 'utf8');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
function run(mode: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'fas-init-retry-'));
  try {
    return spawnSync(
      bash,
      [
        '-c',
        `
set -euo pipefail
FAKE_NOW=1000
PUBLISHED_REGISTRY_DEADLINE=1300
CLI_VERSION=1.2.3
ATTEMPTS=0
MODE='${mode}'
date() { echo "$FAKE_NOW"; }
sleep() { echo "SLEEP $*"; FAKE_NOW=$((FAKE_NOW + $1)); }
timeout() {
  local limit="$1"; shift
  test "$1" = npx || return 2
  ATTEMPTS=$((ATTEMPTS + 1))
  echo "ATTEMPT $ATTEMPTS"
  case "$MODE" in
    eventual|archive-eventual) if [ "$ATTEMPTS" -ge 3 ]; then echo INITIALIZED; return 0; fi ;;
    partial|archive-partial) mkdir fixture ;;
    otherarchive) echo 'npm error 404 Not Found - GET https://registry.npmjs.org/other/-/other-1.2.3.tgz - Not found'; return 1 ;;
    wrongversion) echo 'npm error 404 Not Found - GET https://registry.npmjs.org/@freeappstore/cli/-/cli-1.2.2.tgz - Not found'; return 1 ;;
    other) echo "npm error EACCES"; return 1 ;;
    timeout) FAKE_NOW=$((FAKE_NOW + \${limit%s})); return 124 ;;
  esac
  if [[ "$MODE" == archive* ]]; then
    echo 'npm error 404 Not Found - GET https://registry.npmjs.org/@freeappstore/cli/-/cli-1.2.3.tgz - Not found'
  else
    echo "npm error code ETARGET"
  fi
  return 1
}
${helper}
initialize_published_scaffold fixture --template=standalone
echo CONTINUED
`,
      ],
      { cwd, encoding: 'utf8', timeout: 10_000 },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

it.each(['eventual', 'archive-eventual'])(
  'retries selected CLI propagation failures: %s',
  (mode) => {
    const result = run(mode);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/ATTEMPT/g)).toHaveLength(3);
    expect(result.stdout.match(/SLEEP 5/g)).toHaveLength(2);
    expect(result.stdout).toContain('INITIALIZED');
  },
);

it.each(['partial', 'archive-partial', 'other', 'otherarchive', 'wrongversion'])(
  'does not replay %s initialization failures',
  (mode) => {
    const result = run(mode);
    expect(result.status).toBe(1);
    expect(result.stdout.match(/ATTEMPT/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('SLEEP');
    expect(result.stdout).not.toContain('CONTINUED');
  },
);

it.each(['missing', 'archive'])(
  'bounds persistent propagation failures by the original deadline: %s',
  (mode) => {
    const result = run(mode);
    expect(result.status).toBe(1);
    expect(result.stdout.match(/SLEEP 5/g)).toHaveLength(60);
    expect(result.stdout).toContain('shared five-minute deadline');
  },
);

it('does not retry an init that times out', () => {
  const result = run('timeout');
  expect(result.status).toBe(124);
  expect(result.stdout.match(/ATTEMPT/g)).toHaveLength(1);
});
