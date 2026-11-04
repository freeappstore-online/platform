import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runRuntimeTests } from '../workers/agent/scripts/test-runtime.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function localAppData() {
  const root = mkdtempSync(path.join(tmpdir(), 'fas-launcher-'));
  roots.push(root);
  return root;
}

it('replaces a long inherited Windows TEMP and TMP only for the child, then removes its files', () => {
  const root = localAppData();
  const env = {
    LOCALAPPDATA: root,
    TEMP: 'C:/very-long-session/'.repeat(20),
    TMP: 'C:/other',
    KEEP: 'yes',
  };
  let used: string;
  const status = runRuntimeTests({
    platform: 'win32',
    env,
    args: ['test/runtime/agent.test.ts'],
    spawn(command, args, options) {
      used = options.env.TEMP;
      expect(command).toBe(process.execPath);
      expect(args.slice(1)).toEqual([
        'run',
        '--config',
        'vitest.runtime.ts',
        'test/runtime/agent.test.ts',
      ]);
      expect(options.env.TMP).toBe(used);
      expect(options.env.KEEP).toBe('yes');
      expect(path.dirname(used)).toBe(path.join(root, 'Temp'));
      expect(existsSync(used)).toBe(true);
      writeFileSync(path.join(used, 'storage.sqlite'), 'fixture');
      return { status: 7 };
    },
  });
  expect(status).toBe(7);
  expect(existsSync(used!)).toBe(false);
  expect(env.TMP).toBe('C:/other');
  expect(env.TEMP).toContain('very-long-session');
});

it('cleans up even when Node cannot start', () => {
  const root = localAppData();
  expect(() =>
    runRuntimeTests({
      platform: 'win32',
      env: { LOCALAPPDATA: root },
      spawn: () => ({ error: new Error('spawn failed') }),
    }),
  ).toThrow('spawn failed');
  expect(readdirSync(path.join(root, 'Temp'))).toEqual([]);
});

it('preserves the environment on other platforms and reports signal termination as failure', () => {
  const env = { TEMP: '/tmp/session', TMP: '/tmp/session' };
  expect(
    runRuntimeTests({
      platform: 'linux',
      env,
      spawn(_command, _args, options) {
        expect(options.env).toBe(env);
        return { status: null, signal: 'SIGTERM' };
      },
    }),
  ).toBe(1);
});
