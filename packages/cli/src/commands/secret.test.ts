import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppIdOrExit } from './secret.js';

function chdir(d: string): () => void {
  const prev = process.cwd();
  process.chdir(d);
  return () => process.chdir(prev);
}

describe('resolveAppIdOrExit', () => {
  it('returns the explicit id when valid', async () => {
    expect(await resolveAppIdOrExit('weather')).toBe('weather');
  });

  it('exits on an invalid explicit id', async () => {
    const exitSpy = mockExit();
    await expect(resolveAppIdOrExit('UPPERCASE')).rejects.toThrow('exit:1');
    exitSpy.restore();
  });

  it('falls back to package.json name in cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-secret-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'weather' }));
      const restore = chdir(dir);
      try {
        expect(await resolveAppIdOrExit(undefined)).toBe('weather');
      } finally {
        restore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits when no explicit id and package.json is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-secret-'));
    try {
      // Make sure there's no package.json walking up either by making a deep
      // tmp child and chdir-ing into a subdir of /tmp itself, which doesn't
      // have a package.json.
      const sub = join(dir, 'nested');
      mkdirSync(sub);
      const restore = chdir(sub);
      const exitSpy = mockExit();
      try {
        await expect(resolveAppIdOrExit(undefined)).rejects.toThrow('exit:1');
      } finally {
        restore();
        exitSpy.restore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits when package.json name is not a valid app id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-secret-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/pkg' }));
      const restore = chdir(dir);
      const exitSpy = mockExit();
      try {
        await expect(resolveAppIdOrExit(undefined)).rejects.toThrow('exit:1');
      } finally {
        restore();
        exitSpy.restore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mockExit() {
  const original = process.exit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  };
  // Also silence stderr so the test output stays clean.
  const origWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = () => true;
  return {
    restore() {
      process.exit = original;
      process.stderr.write = origWrite;
    },
  };
}
