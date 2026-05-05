import { describe, it, expect } from 'vitest';
import { isAllowedReturnTo } from './origins.js';

describe('isAllowedReturnTo', () => {
  it('allows the apex domain over https', () => {
    expect(isAllowedReturnTo('https://freeappstore.online/')).toBe(true);
  });

  it('allows arbitrary subdomains over https', () => {
    expect(isAllowedReturnTo('https://chess.freeappstore.online/auth/done')).toBe(true);
    expect(isAllowedReturnTo('https://a.b.c.freeappstore.online/x?y=z#hash')).toBe(true);
  });

  it('rejects http on the production domain', () => {
    expect(isAllowedReturnTo('http://chess.freeappstore.online/')).toBe(false);
  });

  it('allows localhost for dev (http and https, any port)', () => {
    expect(isAllowedReturnTo('http://localhost:5173/')).toBe(true);
    expect(isAllowedReturnTo('https://localhost:8443/x')).toBe(true);
    expect(isAllowedReturnTo('http://127.0.0.1:8787/cb')).toBe(true);
  });

  it('rejects unrelated origins', () => {
    expect(isAllowedReturnTo('https://evil.com/')).toBe(false);
    expect(isAllowedReturnTo('https://attacker.example/?x=y')).toBe(false);
  });

  it('rejects look-alike origins that suffix without a dot', () => {
    // "evilfreeappstore.online" must not pass the suffix check.
    expect(isAllowedReturnTo('https://evilfreeappstore.online/')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedReturnTo('not a url')).toBe(false);
    expect(isAllowedReturnTo('')).toBe(false);
    expect(isAllowedReturnTo('javascript:alert(1)')).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isAllowedReturnTo('file:///etc/passwd')).toBe(false);
    expect(isAllowedReturnTo('ftp://freeappstore.online/')).toBe(false);
  });
});
