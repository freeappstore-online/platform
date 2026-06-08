import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bearer, dieFromHttp, resolveAppIdOrExit } from './secret.js';

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

describe('bearer', () => {
  it('sets the Authorization and Content-Type headers from the session token', () => {
    const headers = bearer({
      apiBase: 'https://x',
      session: { token: 'tok-1', obtainedAt: 0 },
    });
    expect(headers).toEqual({
      Authorization: 'Bearer tok-1',
      'Content-Type': 'application/json',
    });
  });
});

describe('dieFromHttp', () => {
  it('extracts `error` from a JSON body and exits 1', async () => {
    const exitSpy = mockExit();
    let captured = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => {
      captured += s;
      return true;
    };
    try {
      const res = new Response(JSON.stringify({ error: 'no allowlist match for X' }), {
        status: 403,
      });
      await expect(dieFromHttp(res, 'do thing')).rejects.toThrow('exit:1');
      expect(captured).toContain('do thing failed (403)');
      expect(captured).toContain('no allowlist match for X');
    } finally {
      process.stderr.write = origWrite;
      exitSpy.restore();
    }
  });

  it('falls back to the raw body when not JSON', async () => {
    const exitSpy = mockExit();
    let captured = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => {
      captured += s;
      return true;
    };
    try {
      const res = new Response('plain text error', { status: 500 });
      await expect(dieFromHttp(res, 'do thing')).rejects.toThrow('exit:1');
      expect(captured).toContain('plain text error');
    } finally {
      process.stderr.write = origWrite;
      exitSpy.restore();
    }
  });

  it('uses raw body when the JSON has no `error` field', async () => {
    const exitSpy = mockExit();
    let captured = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => {
      captured += s;
      return true;
    };
    try {
      const res = new Response('{"unrelated":"field"}', { status: 400 });
      await expect(dieFromHttp(res, 'do thing')).rejects.toThrow('exit:1');
      // Falls back to the raw JSON body since `error` is absent.
      expect(captured).toContain('"unrelated":"field"');
    } finally {
      process.stderr.write = origWrite;
      exitSpy.restore();
    }
  });
});

function mockExit() {
  const original = process.exit;
  (process as any).exit = (code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  };
  // Also silence stderr so the test output stays clean.
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = () => true;
  return {
    restore() {
      process.exit = original;
      process.stderr.write = origWrite;
    },
  };
}
