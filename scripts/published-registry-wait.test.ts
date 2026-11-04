import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const helper = workflow
  .slice(
    workflow.indexOf('          wait_for_published_version() {'),
    workflow.indexOf('          wait_for_published_version "@freeappstore/cli"'),
  )
  .replace(/^ {10}/gm, '');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

// Run the actual workflow function. Mock registry requests and time so tests
// cover the wall-clock deadline without network access or real delays.
function run(mode: string) {
  return spawnSync(
    bash,
    [
      '-c',
      `
set -euo pipefail
FAKE_NOW=1000
MODE='${mode}'
date() { echo "$FAKE_NOW"; }
sleep() { echo "SLEEP $*"; FAKE_NOW=$(( FAKE_NOW + $1 )); }
timeout() {
  local request_limit="$1"
  shift
  test "$1" = 'npm' && test "$2" = 'view' && test "$3" = '@freeappstore/cli@1.2.3' && test "$4" = 'version' || return 2
  test "$5" = '--registry=https://registry.npmjs.org' && test "$6" = '--prefer-online' && test "$7" = '--fetch-retries=0' || return 2
  case "$request_limit:$8" in
    5s:--fetch-timeout=4500|[1-4]s:--fetch-timeout=*) ;;
    *) return 2 ;;
  esac
  case "$MODE" in
    eventual) if [ "$FAKE_NOW" -lt 1010 ]; then return 1; fi; echo 1.2.3 ;;
    wrong) echo 9.9.9 ;;
    missing) return 1 ;;
  esac
}
${helper}
wait_for_published_version '@freeappstore/cli' '1.2.3'
echo CONTINUED
`,
    ],
    { encoding: 'utf8', timeout: 12_000 },
  );
}

describe('published scaffold registry propagation', () => {
  it('waits through transient failures, then accepts the exact version', () => {
    const result = run('eventual');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('attempt 3; within five-minute deadline');
    expect(result.stdout.match(/SLEEP 5/g)).toHaveLength(2);
    expect(result.stdout).toContain('CONTINUED');
  });

  it.each(['missing', 'wrong'])(
    'fails persistently %s versions within the wall-clock deadline',
    (mode) => {
      const result = run(mode);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout.match(/SLEEP 5/g)).toHaveLength(60);
      expect(result.stdout).toContain('within five minutes');
      expect(result.stdout).toContain('@freeappstore/cli@1.2.3');
      expect(result.stdout).not.toContain('CONTINUED');
    },
    15_000,
  );

  it('waits for both pinned versions before initializing the scaffold', () => {
    for (const pkg of ['cli', 'sdk']) {
      const call = `wait_for_published_version "@freeappstore/${pkg}" "$${pkg.toUpperCase()}_VERSION"`;
      expect(workflow.indexOf(call)).toBeGreaterThan(
        workflow.indexOf('needs.publish.outputs.versions'),
      );
      expect(workflow.indexOf(call)).toBeLessThan(workflow.indexOf('npx --yes'));
    }
    const requestTimeout = '$' + '{request_seconds}s';
    expect(helper).toContain(`timeout "${requestTimeout}" npm view "$package@$version" version`);
    expect(helper).toContain('--registry=https://registry.npmjs.org');
    expect(helper).toContain('deadline=$(( $(date +%s) + 300 ))');
    expect(helper).toContain('fetch_timeout_ms=$(( request_seconds * 1000 - 500 ))');
  });
});
