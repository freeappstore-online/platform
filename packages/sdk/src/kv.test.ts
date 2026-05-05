import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Kv } from './kv.js';
import type { Auth } from './auth.js';

function fakeAuth(token: string | null): Auth {
  return { token } as unknown as Auth;
}

beforeEach(() => {
  // 204/304 require a null body per WHATWG; an empty string would throw.
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['fetch'];
});

describe('Kv key validation', () => {
  const kv = (token: string | null = 'tok') =>
    new Kv('demo', 'https://api.example', fakeAuth(token));

  it('rejects empty-string key (regression: would yield /kv/ URL and a confusing 404)', async () => {
    await expect(kv().get('')).rejects.toThrow(/non-empty/);
    await expect(kv().set('', 1)).rejects.toThrow(/non-empty/);
    await expect(kv().delete('')).rejects.toThrow(/non-empty/);
  });

  it('rejects keys longer than 128 chars', async () => {
    const long = 'x'.repeat(129);
    await expect(kv().set(long, 1)).rejects.toThrow(/128/);
  });

  it('accepts a 128-char key (boundary)', async () => {
    const ok = 'x'.repeat(128);
    await expect(kv().set(ok, 1)).resolves.toBeUndefined();
  });

  it('accepts ordinary keys', async () => {
    await expect(kv().set('foo', 1)).resolves.toBeUndefined();
    await expect(kv().set('a/b', 1)).resolves.toBeUndefined();
    await expect(kv().set('color-preference', 1)).resolves.toBeUndefined();
  });
});

describe('Kv.set value validation', () => {
  const kv = () => new Kv('demo', 'https://api.example', fakeAuth('tok'));

  it('rejects undefined (regression: would store empty body, then break get)', async () => {
    await expect(kv().set('k', undefined)).rejects.toThrow(/undefined/);
  });

  it('accepts null as a stored value', async () => {
    await expect(kv().set('k', null)).resolves.toBeUndefined();
  });
});

describe('Kv auth gate', () => {
  it('throws Not signed in when no session token', async () => {
    const k = new Kv('demo', 'https://api.example', fakeAuth(null));
    await expect(k.get('foo')).rejects.toThrow(/not signed in/i);
  });
});

describe('Kv.get behavior', () => {
  it('returns null on 404, the missing-key signal', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const k = new Kv('demo', 'https://api.example', fakeAuth('tok'));
    expect(await k.get('missing')).toBeNull();
  });

  it('parses JSON on 200', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ x: 1 }), { status: 200 }));
    const k = new Kv('demo', 'https://api.example', fakeAuth('tok'));
    expect(await k.get<{ x: number }>('foo')).toEqual({ x: 1 });
  });

  it('throws on non-404 errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const k = new Kv('demo', 'https://api.example', fakeAuth('tok'));
    await expect(k.get('foo')).rejects.toThrow(/500/);
  });
});
