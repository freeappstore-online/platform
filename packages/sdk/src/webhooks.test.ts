import { afterEach, describe, expect, it, vi } from 'vitest';
import { Webhooks } from './webhooks.js';

function fakeAuth(token: string | null) {
  return { token, handleUnauthorized: vi.fn() };
}

function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  globalThis.fetch = fn;
  return fn;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('Webhooks', () => {
  it('encodes the app and webhook ids in the path', async () => {
    const fetchMock = mockFetch(200, { status: 204 });
    const hooks = new Webhooks('my app', 'https://api.example', fakeAuth('tok'));
    expect(await hooks.test('a/b')).toEqual({ status: 204 });
    await hooks.delete('a/b');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.example/v1/apps/my%20app/webhooks/a%2Fb/test',
      'https://api.example/v1/apps/my%20app/webhooks/a%2Fb',
    ]);
    expect(fetchMock.mock.calls[1]![1].method).toBe('DELETE');
  });

  it('lists with the bearer token', async () => {
    const fetchMock = mockFetch(200, { webhooks: [], supported_events: ['kv.changed'] });
    const result = await new Webhooks('a', 'https://api.example', fakeAuth('tok')).list();
    expect(result.supported_events).toEqual(['kv.changed']);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer tok');
  });

  it('has no create: registration is console-only', () => {
    expect('create' in Webhooks.prototype).toBe(false);
  });

  it('drops an expired session on 401', async () => {
    mockFetch(401);
    const auth = fakeAuth('tok');
    await expect(new Webhooks('a', 'https://api.example', auth).list()).rejects.toThrow(
      'Not signed in.',
    );
    expect(auth.handleUnauthorized).toHaveBeenCalledWith('tok');
  });
});
