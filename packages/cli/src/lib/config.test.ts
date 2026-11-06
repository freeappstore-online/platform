import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type FasConfig,
  normalizeApiBase,
  SESSION_TTL_MS,
  sessionDaysRemaining,
} from './config.js';

describe('normalizeApiBase', () => {
  it('leaves a clean URL alone', () => {
    expect(normalizeApiBase('https://api.freeappstore.online')).toBe(
      'https://api.freeappstore.online',
    );
  });

  it('strips a single trailing slash (regression: //health URLs)', () => {
    expect(normalizeApiBase('https://api.freeappstore.online/')).toBe(
      'https://api.freeappstore.online',
    );
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeApiBase('https://api.freeappstore.online////')).toBe(
      'https://api.freeappstore.online',
    );
  });

  it('preserves path segments and only strips the rightmost slashes', () => {
    expect(normalizeApiBase('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeApiBase('https://api.example.com/v1//')).toBe('https://api.example.com/v1');
  });

  it('handles localhost dev URLs', () => {
    expect(normalizeApiBase('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(normalizeApiBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });
});

describe('sessionDaysRemaining', () => {
  const base: FasConfig = { apiBase: 'https://api.freeappstore.online' };

  it('returns null when there is no session', () => {
    expect(sessionDaysRemaining(base)).toBeNull();
  });

  it('returns null for a legacy session with no obtainedAt (can not tell)', () => {
    const cfg = { ...base, session: { token: 't' } } as unknown as FasConfig;
    expect(sessionDaysRemaining(cfg)).toBeNull();
  });

  it('returns ~30 for a fresh token', () => {
    const cfg: FasConfig = { ...base, session: { token: 't', obtainedAt: Date.now() } };
    expect(sessionDaysRemaining(cfg)).toBe(30);
  });

  it('is positive but small for a nearly-expired token', () => {
    const obtainedAt = Date.now() - (SESSION_TTL_MS - 2 * 24 * 60 * 60 * 1000);
    const cfg: FasConfig = { ...base, session: { token: 't', obtainedAt } };
    expect(sessionDaysRemaining(cfg)).toBe(2);
  });

  it('is <= 0 for an expired token', () => {
    const obtainedAt = Date.now() - (SESSION_TTL_MS + 24 * 60 * 60 * 1000);
    const cfg: FasConfig = { ...base, session: { token: 't', obtainedAt } };
    expect(sessionDaysRemaining(cfg)).toBeLessThanOrEqual(0);
  });
});

describe('resolveApiBase (#520)', () => {
  it('defaults to the production API', async () => {
    const { resolveApiBase } = await import('./config.js');
    expect(resolveApiBase(undefined)).toBe('https://api.freeappstore.online');
  });

  it('accepts https and localhost http, and strips trailing slashes', async () => {
    const { resolveApiBase } = await import('./config.js');
    expect(resolveApiBase('https://api.example.com/')).toBe('https://api.example.com');
    expect(resolveApiBase('http://localhost:8787')).toBe('http://localhost:8787');
    expect(resolveApiBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });

  it.each(['http://api.example.com', 'ftp://localhost', 'not a url', 'http://localhost.evil.com'])(
    'refuses %s',
    async (v) => {
      const { resolveApiBase } = await import('./config.js');
      expect(() => resolveApiBase(v)).toThrow(/FAS_API_BASE/);
    },
  );
});

describe('config file (#481, #520)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshHome() {
    const home = await mkdtemp(join(tmpdir(), 'fas-cfg-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.resetModules();
    return home;
  }

  it('never persists FAS_API_BASE, and ignores a stored apiBase', async () => {
    const home = await freshHome();
    vi.stubEnv('FAS_API_BASE', 'https://attacker.example');
    const cfg = await import('./config.js');
    await cfg.writeConfig({ ...(await cfg.readConfig()), session: { token: 't', obtainedAt: 1 } });
    const onDisk = JSON.parse(await readFile(join(home, '.fas', 'config.json'), 'utf8'));
    expect(onDisk).not.toHaveProperty('apiBase');
    expect(JSON.stringify(onDisk)).not.toContain('attacker');

    // A poisoned file from an older version does not redirect later runs.
    await writeFile(
      join(home, '.fas', 'config.json'),
      JSON.stringify({ apiBase: 'https://attacker.example' }),
    );
    vi.stubEnv('FAS_API_BASE', '');
    expect((await cfg.readConfig()).apiBase).toBe('https://api.freeappstore.online');
  });

  it('drops a stored GitHub access token on the next write', async () => {
    const home = await freshHome();
    const cfg = await import('./config.js');
    await mkdir(join(home, '.fas'), { recursive: true });
    await writeFile(
      join(home, '.fas', 'config.json'),
      JSON.stringify({
        github: { accessToken: 'gho_secret', login: 'alice', obtainedAt: 1 },
        session: { token: 't', obtainedAt: 1 },
      }),
    );
    await cfg.writeConfig(await cfg.readConfig());
    const raw = await readFile(join(home, '.fas', 'config.json'), 'utf8');
    expect(raw).not.toContain('gho_secret');
    expect(JSON.parse(raw).github).toEqual({ login: 'alice' });
  });

  it.skipIf(process.platform === 'win32')('tightens an existing 0755 ~/.fas to 0700', async () => {
    const home = await freshHome();
    await mkdir(join(home, '.fas'), { mode: 0o755 });
    const cfg = await import('./config.js');
    await cfg.writeConfig({ apiBase: 'x' });
    expect((await stat(join(home, '.fas'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, '.fas', 'config.json'))).mode & 0o777).toBe(0o600);
  });
});
