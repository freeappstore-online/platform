import { describe, expect, it, vi } from 'vitest';
import { ApiProxy, normalizeTarget, ProxyNoGrantError } from './proxy.js';

describe('normalizeTarget', () => {
  it('passes through bare host/path form', () => {
    expect(normalizeTarget('api.example.com/v1/x')).toBe('api.example.com/v1/x');
  });

  it('strips https:// and http:// prefixes', () => {
    expect(normalizeTarget('https://api.example.com/v1/x')).toBe('api.example.com/v1/x');
    expect(normalizeTarget('http://api.example.com/v1/x')).toBe('api.example.com/v1/x');
  });

  it('matches the scheme case-insensitively', () => {
    expect(normalizeTarget('HTTPS://api.example.com/v1/x')).toBe('api.example.com/v1/x');
    expect(normalizeTarget('Http://api.example.com/v1/x')).toBe('api.example.com/v1/x');
  });

  it('strips leading slashes from bare form', () => {
    expect(normalizeTarget('//api.example.com/v1')).toBe('api.example.com/v1');
  });

  it('preserves query strings', () => {
    expect(normalizeTarget('api.example.com/x?a=1&b=2')).toBe('api.example.com/x?a=1&b=2');
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeTarget('ftp://api.example.com/x')).toThrow(/http\(s\)/);
    expect(() => normalizeTarget('javascript://x')).toThrow(/http\(s\)/);
  });
});

interface FakeAuth {
  token: string | null;
}

describe('Proxy.fetch', () => {
  it("throws ProxyNoGrantError when the user's vault key may not be used here (#495)", async () => {
    const proxy = new ApiProxy('weather', 'https://api.example.com', { token: 't' } as never);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'no_grant', provider: 'openai' }, { status: 403 }),
    ) as typeof fetch;
    try {
      const err = await proxy.fetch('api.openai.com/v1/models').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProxyNoGrantError);
      expect((err as ProxyNoGrantError).provider).toBe('openai');
      expect((err as Error).message).toContain('openai');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('passes any other 403 through as a response', async () => {
    const proxy = new ApiProxy('weather', 'https://api.example.com', { token: 't' } as never);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'no allowlist match' }, { status: 403 }),
    ) as typeof fetch;
    try {
      const res = await proxy.fetch('api.example.org/x');
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('no allowlist match');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('throws when not signed in', async () => {
    const auth: FakeAuth = { token: null };
    const proxy = new ApiProxy('weather', 'https://api.example.com', auth as never);
    await expect(proxy.fetch('api.openweathermap.org/data/2.5/weather')).rejects.toThrow(
      /not signed in/,
    );
  });

  it('builds the right URL and forwards Bearer auth', async () => {
    const auth: FakeAuth = { token: 'tok-123' };
    const proxy = new ApiProxy('weather', 'https://api.example.com', auth as never);
    const captured: { url?: string; init?: RequestInit | undefined } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response('ok');
    }) as typeof fetch;
    try {
      await proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London');
      expect(captured.url).toBe(
        'https://api.example.com/v1/apps/weather/proxy/api.openweathermap.org/data/2.5/weather?q=London',
      );
      const h = new Headers(captured.init?.headers);
      expect(h.get('authorization')).toBe('Bearer tok-123');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('preserves caller-supplied headers and method', async () => {
    const auth: FakeAuth = { token: 'tok' };
    const proxy = new ApiProxy('weather', 'https://api.example.com', auth as never);
    const captured: { init?: RequestInit | undefined } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.init = init;
      return new Response('ok');
    }) as typeof fetch;
    try {
      await proxy.fetch('api.example.com/v1/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(captured.init?.method).toBe('POST');
      const h = new Headers(captured.init?.headers);
      expect(h.get('content-type')).toBe('application/json');
      expect(h.get('authorization')).toBe('Bearer tok');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
