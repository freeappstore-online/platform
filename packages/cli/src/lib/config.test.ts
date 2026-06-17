import { describe, expect, it } from 'vitest';
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
