import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  APP_DEPLOY_CLI_VERSION,
  INSTALL_APP_DEPENDENCIES,
  SAVE_APP_DEPENDENCY_LOCK,
} from '../packages/cli/src/lib/starter-dependencies.js';
import { getTemplateFiles } from '../packages/cli/src/lib/starter-foundation.js';

const dirs: string[] = [];
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'fas-lock-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(['missing', 'current', 'changed', 'network', 'lifecycle'])(
  'handles %s dependencies without retrying unrelated install failures',
  (mode) => {
    const cwd = temporary();
    if (mode !== 'missing') writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'retained');
    const result = spawnSync(
      bash,
      [
        '-c',
        `
pnpm() {
  echo "INSTALL $*"
  if [ "$2" = --no-frozen-lockfile ]; then echo resolved > pnpm-lock.yaml; fi
  if [ "$2" = --frozen-lockfile ]; then
    case "$MODE" in
      changed) echo "ERR_PNPM_OUTDATED_LOCKFILE"; return 1 ;;
      network) echo "ERR_PNPM_FETCH_503"; return 9 ;;
      lifecycle) echo "ELIFECYCLE"; return 7 ;;
    esac
  fi
}
${INSTALL_APP_DEPENDENCIES}`,
      ],
      { cwd, encoding: 'utf8', env: { ...process.env, MODE: mode } },
    );
    expect(result.status).toBe(mode === 'network' ? 9 : mode === 'lifecycle' ? 7 : 0);
    const calls = result.stdout.split('\n').filter((line) => line.startsWith('INSTALL'));
    expect(calls).toEqual(
      mode === 'missing'
        ? ['INSTALL install --no-frozen-lockfile']
        : mode === 'changed'
          ? ['INSTALL install --frozen-lockfile', 'INSTALL install --no-frozen-lockfile']
          : ['INSTALL install --frozen-lockfile'],
    );
    expect(readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8').trim()).toBe(
      mode === 'missing' || mode === 'changed' ? 'resolved' : 'retained',
    );
  },
);

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

it('retains only the validated lock and rejects concurrent main changes', () => {
  const remote = temporary();
  git(remote, 'init', '--bare', '--initial-branch=main');
  const app = temporary();
  git(app, 'clone', remote, '.');
  git(app, 'config', 'user.email', 'test@example.test');
  git(app, 'config', 'user.name', 'Test');
  writeFileSync(join(app, 'package.json'), '{}');
  git(app, 'add', 'package.json');
  git(app, 'commit', '-m', 'Initial app');
  git(app, 'push', 'origin', 'main');
  const acceptedSource = git(app, 'rev-parse', 'HEAD');
  writeFileSync(join(app, 'pnpm-lock.yaml'), 'accepted dependency graph');
  writeFileSync(join(app, 'unrelated.txt'), 'not part of this commit');
  const save = () =>
    spawnSync(bash, ['-c', SAVE_APP_DEPENDENCY_LOCK], { cwd: app, encoding: 'utf8' });
  expect(save().status).toBe(0);
  expect(git(remote, 'show', 'main:pnpm-lock.yaml')).toBe('accepted dependency graph');
  expect(git(app, 'diff', '--name-only', acceptedSource, 'HEAD')).toBe('pnpm-lock.yaml');
  const lockCommit = git(app, 'rev-parse', 'HEAD');
  expect(save().status).toBe(0);
  expect(git(app, 'rev-parse', 'HEAD')).toBe(lockCommit);

  const concurrent = temporary();
  git(concurrent, 'clone', remote, '.');
  git(concurrent, 'config', 'user.email', 'test@example.test');
  git(concurrent, 'config', 'user.name', 'Test');
  writeFileSync(join(concurrent, 'package.json'), '{"changed":true}');
  git(concurrent, 'add', 'package.json');
  git(concurrent, 'commit', '-m', 'New app work');
  git(concurrent, 'push', 'origin', 'main');
  const newHead = git(remote, 'rev-parse', 'main');
  writeFileSync(join(app, 'pnpm-lock.yaml'), 'older build lock');
  expect(save().status).not.toBe(0);
  expect(git(remote, 'rev-parse', 'main')).toBe(newHead);
}, 30_000);

it('reproduces a fresh minimal workspace and deliberately updates changed manifests with real pnpm', () => {
  const cwd = temporary();
  writeFileSync(join(cwd, 'package.json'), '{"private":true,"packageManager":"pnpm@10.30.3"}');
  const run = () =>
    spawnSync(bash, ['-c', INSTALL_APP_DEPENDENCIES], { cwd, encoding: 'utf8', timeout: 30_000 });
  expect(run().status).toBe(0);
  expect(existsSync(join(cwd, 'pnpm-lock.yaml'))).toBe(true);
  const lock = readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8');
  expect(run().status).toBe(0);
  expect(readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8')).toBe(lock);
  mkdirSync(join(cwd, 'fixture'));
  writeFileSync(join(cwd, 'fixture/package.json'), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      private: true,
      packageManager: 'pnpm@10.30.3',
      dependencies: { fixture: 'file:./fixture' },
    }),
  );
  const changed = run();
  expect(changed.status, changed.stderr).toBe(0);
  expect(changed.stdout).toContain('Dependency manifests changed');
  const updated = readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8');
  expect(updated).not.toBe(lock);
  expect(run().status).toBe(0);
  expect(readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8')).toBe(updated);
}, 60_000);

it('ships the tested scripts in build order and pins both validators', () => {
  const files = getTemplateFiles({ store: 'apps', r2Bucket: 'fas-apps', nounPlural: 'apps' });
  const workflow = files['.github/workflows/deploy.yml']!;
  expect(workflow).toContain('contents: write');
  expect(workflow).toContain(
    INSTALL_APP_DEPENDENCIES.trimEnd()
      .split('\n')
      .map((line) => `          ${line}`)
      .join('\n'),
  );
  expect(workflow).toContain(
    SAVE_APP_DEPENDENCY_LOCK.trimEnd()
      .split('\n')
      .map((line) => `          ${line}`)
      .join('\n'),
  );
  expect(
    workflow.match(
      new RegExp(`@freeappstore/cli@${APP_DEPLOY_CLI_VERSION.replaceAll('.', '\\.')}`, 'g'),
    ),
  ).toHaveLength(2);
  expect(workflow.indexOf('Verify build output')).toBeLessThan(
    workflow.indexOf('Retain verified dependency lock'),
  );
  expect(workflow.indexOf('Retain verified dependency lock')).toBeLessThan(
    workflow.indexOf('Upload keylessly'),
  );
});

it.each(['missing', 'passing', 'failing'])(
  'runs configured app tests before accepting a deployment: %s',
  (mode) => {
    const cwd = temporary();
    const files = getTemplateFiles({ store: 'apps', r2Bucket: 'fas-apps', nounPlural: 'apps' });
    const workflow = files['.github/workflows/deploy.yml']!;
    const command = /- name: Tests \(when configured\)\n\s+run: ([^\n]+)/.exec(workflow)![1]!;
    const stages = [
      'Typecheck (when configured)',
      'Tests (when configured)',
      '- name: Build',
      'Verify build output',
      'Retain verified dependency lock',
      'Upload keylessly',
    ].map((name) => workflow.indexOf(name));
    expect(stages.every((position) => position >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'pnpm@10.30.3',
        ...(mode === 'missing'
          ? {}
          : {
              scripts: {
                test:
                  mode === 'passing' ? 'node -e "process.exit(0)"' : 'node -e "process.exit(7)"',
              },
            }),
      }),
    );
    const result = spawnSync(bash, ['-ec', `${command}\necho accepted > accepted-artifact`], {
      cwd,
      encoding: 'utf8',
    });
    expect(result.status === 0, result.stderr).toBe(mode !== 'failing');
    expect(existsSync(join(cwd, 'accepted-artifact'))).toBe(mode !== 'failing');
  },
  20_000,
);
