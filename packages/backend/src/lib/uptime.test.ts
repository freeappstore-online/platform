import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { burstCheck, burstSample, checkUrl } from './uptime.js';

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

describe('burstSample (#642)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'run'];

  it('always includes run and rotates a window through the other apps', () => {
    expect(burstSample(ids, 0, 2)).toEqual(['run', 'a', 'b']);
    expect(burstSample(ids, 1, 2)).toEqual(['run', 'c', 'd']);
    expect(burstSample(ids, 2, 2)).toEqual(['run', 'e', 'f']);
    expect(burstSample(ids, 3, 2)).toEqual(['run', 'a', 'b']);
    expect(burstSample(['f', 'e', 'd', 'c', 'b', 'a'], 5, 4)).toEqual(['run', 'c', 'd', 'e', 'f']);
  });

  it('takes every app when there are fewer than the sample, and run alone without a registry', () => {
    expect(burstSample(['b', 'a', 'a'], 7, 4)).toEqual(['run', 'a', 'b']);
    expect(burstSample([], 7)).toEqual(['run']);
  });
});

describe('burstCheck (#642)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends the requests concurrently and passes when all answer', async () => {
    let open = 0;
    let peak = 0;
    globalThis.fetch = vi.fn(async () => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return new Response('', { status: 200 });
    });
    const result = await burstCheck('https://run.freeappstore.online/', 6);
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    expect(peak).toBe(6);
    expect(result).toMatchObject({ ok: true, status: 200, error: null });
  });

  it('fails when any request in the burst returns a 5xx (the 1101 shape)', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(
      async () => new Response('error code: 1101', { status: ++n % 2 === 0 ? 500 : 200 }),
    );
    const result = await burstCheck('https://run.freeappstore.online/', 6);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe('3/6 failed: http 500');
  });
});
