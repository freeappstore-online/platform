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

// Run the actual workflow function. Replace external commands so no registry
// access or real delays are needed, while preserving exit codes and arguments.
function run(mode: string) {
  return spawnSync(
    bash,
    [
      '-c',
      `
set -euo pipefail
timeout() {
  test "$*" = '5s npm view @freeappstore/cli@1.2.3 version --registry=https://registry.npmjs.org --prefer-online --fetch-retries=0 --fetch-timeout=4000' || return 2
  case "${mode}" in
    eventual) if [ "$attempt" -lt 3 ]; then return 1; fi; echo 1.2.3 ;;
    wrong) echo 9.9.9 ;;
    missing) return 1 ;;
  esac
}
sleep() { echo "SLEEP $*"; }
${helper}
wait_for_published_version '@freeappstore/cli' '1.2.3'
echo CONTINUED
`,
    ],
    { encoding: 'utf8' },
  );
}

describe('published scaffold registry propagation', () => {
  it('waits through transient failures, then accepts the exact version', () => {
    const result = run('eventual');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('attempt 3/30');
    expect(result.stdout.match(/SLEEP 5/g)).toHaveLength(2);
    expect(result.stdout).toContain('CONTINUED');
  });

  it.each(['missing', 'wrong'])('fails persistently %s versions without continuing', (mode) => {
    const result = run(mode);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout.match(/SLEEP 5/g)).toHaveLength(29);
    expect(result.stdout).toContain('up to 295 seconds');
    expect(result.stdout).toContain('@freeappstore/cli@1.2.3');
    expect(result.stdout).not.toContain('CONTINUED');
  });

  it('waits for both pinned versions before initializing the scaffold', () => {
    for (const pkg of ['cli', 'sdk']) {
      const call = `wait_for_published_version "@freeappstore/${pkg}" "$${pkg.toUpperCase()}_VERSION"`;
      expect(workflow.indexOf(call)).toBeGreaterThan(
        workflow.indexOf('needs.publish.outputs.versions'),
      );
      expect(workflow.indexOf(call)).toBeLessThan(workflow.indexOf('npx --yes'));
    }
    expect(helper).toContain('timeout 5s npm view "$package@$version" version');
    expect(helper).toContain('--registry=https://registry.npmjs.org');
  });
});
