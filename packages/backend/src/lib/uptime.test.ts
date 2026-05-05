import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkUrl } from './uptime.js';

describe('checkUrl', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('returns ok=true for a 200', async () => {
    let t = 1000;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const result = await checkUrl('https://example.com', () => (t += 50));
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('counts 4xx as ok (origin is reachable, just returning 4xx)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const result = await checkUrl('https://example.com');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(404);
    expect(result.error).toBeNull();
  });

  it('counts 5xx as not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const result = await checkUrl('https://example.com');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBe('http 503');
  });

  it('reports network errors with the error message', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const result = await checkUrl('https://example.com');
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain('ENOTFOUND');
  });

  it('reports timeout-shaped errors as a timeout message', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const result = await checkUrl('https://example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/);
  });
});
