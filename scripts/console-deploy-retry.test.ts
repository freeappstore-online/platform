import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-console.yml', import.meta.url),
  'utf8',
);
const allocation = workflow
  .slice(
    workflow.indexOf('          request_deploy_session() {'),
    workflow.indexOf('          DEPLOY_TOKEN='),
  )
  .replace(/^ {10}/gm, '');
const mock = `
set -euo pipefail
oidc=fixture-oidc
curl() {
  local count code output='' arg
  count=$(cat "$RUNNER_TEMP/attempts")
  count=$((count + 1))
  printf '%s' "$count" > "$RUNNER_TEMP/attempts"
  code=$(sed -n "\${count}p" "$RUNNER_TEMP/codes")
  while [[ $# -gt 0 ]]; do
    arg=$1; shift
    if [[ "$arg" == -o ]]; then output=$1; shift; fi
    if [[ "$arg" == -H ]]; then
      if [[ "$1" == 'Authorization: '* ]]; then printf '%s\\n' "$1" >> "$RUNNER_TEMP/authorization"; fi
      shift
    fi
  done
  if [[ "$code" == transport ]]; then return 28; fi
  if [[ "$code" == 201 ]]; then printf '{"id":"one-session","token":"fixture-deploy"}' > "$output";
  else printf '{"error":"fixture failure"}' > "$output"; fi
  printf '%s' "$code"
}
sleep() { printf '%s\\n' "$1" >> "$RUNNER_TEMP/sleeps"; }
`;

function run(codes: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'fas-console-retry-'));
  try {
    writeFileSync(join(dir, 'codes'), codes.join('\n') + '\n');
    writeFileSync(join(dir, 'attempts'), '0');
    writeFileSync(join(dir, 'sleeps'), '');
    writeFileSync(join(dir, 'authorization'), '');
    const result = spawnSync('bash', ['-c', mock + allocation + '\nprintf "%s" "$session"'], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: dir, DEPLOY_API: 'https://deploy.example' },
    });
    return {
      ...result,
      attempts: Number(readFileSync(join(dir, 'attempts'), 'utf8')),
      sleeps: readFileSync(join(dir, 'sleeps'), 'utf8').trim().split('\n').filter(Boolean),
      authorization: readFileSync(join(dir, 'authorization'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('console deploy session retry', () => {
  it('retries transient server errors with the same OIDC identity', () => {
    const result = run(['500', '503', '201']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: 'one-session', token: 'fixture-deploy' });
    expect(result.attempts).toBe(3);
    expect(result.sleeps).toEqual(['5', '10']);
    expect(result.authorization).toEqual(Array(3).fill('Authorization: Bearer fixture-oidc'));
  });
  it.each(['400', '401', '403', '409', '429'])('does not retry HTTP %s', (code) => {
    const result = run([code, '201']);
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.stdout).toBe('');
  });
  it('stops after four server errors and leaves deployment failed', () => {
    const result = run(['500', '502', '503', '504', '201']);
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(4);
    expect(result.sleeps).toEqual(['5', '10', '15']);
    expect(result.stdout).toBe('');
  });
  it('stops on replay if prior allocation succeeded but its response was lost', () => {
    const result = run(['500', '409', '201']);
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(2);
    expect(result.stdout).toBe('');
  });
  it('does not repeat requests after ambiguous transport failure', () => {
    const result = run(['transport', '201']);
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.sleeps).toEqual([]);
  });
});
