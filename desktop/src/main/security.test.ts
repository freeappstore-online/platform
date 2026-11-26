import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeOriginAppId, isAuthorized } from './security.js';
import { loadToken, regenerateToken } from './token.js';

describe('bridgeOriginAppId', () => {
  it('lets https://<id>.freeappstore.online register only <id>', () => {
    expect(bridgeOriginAppId('https://spreadsheet.freeappstore.online', false)).toBe('spreadsheet');
    expect(bridgeOriginAppId('https://spreadsheet.freeappstore.online', true)).toBe('spreadsheet');
  });

  it.each([
    undefined,
    '',
    'null',
    'https://freeappstore.online',
    'http://spreadsheet.freeappstore.online',
    'https://spreadsheet.freeappstore.online:8443',
    'https://spreadsheet.freeappstore.online.evil.com',
    'https://evil-freeappstore.online',
    'https://a.b.freeappstore.online',
    'https://evil.com',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ])('refuses %s in a release build', (origin) => {
    expect(bridgeOriginAppId(origin, false)).toBeNull();
  });

  it('accepts http://localhost:* and http://127.0.0.1:* only in dev builds', () => {
    expect(bridgeOriginAppId('http://localhost:5173', true)).toBe('*');
    expect(bridgeOriginAppId('http://127.0.0.1:4000', true)).toBe('*');
    expect(bridgeOriginAppId('https://localhost:5173', true)).toBeNull();
    expect(bridgeOriginAppId('http://localhost.evil.com', true)).toBeNull();
  });
});

describe('isAuthorized', () => {
  const token = 'tok_abcdefghijklmnopqrstuvwxyz0123456789';
  it('accepts exactly "Bearer <token>"', () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
  });
  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer ',
    token,
    `Basic ${token}`,
    `Bearer ${token}x`,
    `Bearer ${token.slice(0, -1)}`,
    `Bearer ${token} extra`,
  ])('refuses %s', (header) => {
    expect(isAuthorized(header, token)).toBe(false);
  });
});

describe('MCP token file', () => {
  it('is created once with 0600 permissions, reused, and regenerated on request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-token-'));
    const first = loadToken(dir);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(dir, 'mcp-token')).mode & 0o777).toBe(0o600);
    expect(loadToken(dir)).toBe(first);
    const second = regenerateToken(dir);
    expect(second).not.toBe(first);
    expect(readFileSync(join(dir, 'mcp-token'), 'utf8')).toBe(second);
    expect(statSync(join(dir, 'mcp-token')).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions on an existing token file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fas-token-'));
    writeFileSync(join(dir, 'mcp-token'), 'existing', { mode: 0o644 });
    expect(loadToken(dir)).toBe('existing');
    expect(statSync(join(dir, 'mcp-token')).mode & 0o777).toBe(0o600);
  });
});
