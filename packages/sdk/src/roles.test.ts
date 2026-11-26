import { afterEach, describe, expect, it, vi } from 'vitest';
import { Roles } from './roles.js';

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

describe('Roles', () => {
  it('assigns with the bearer token and an encoded app id', async () => {
    const fetchMock = mockFetch(200);
    await new Roles('my app', 'https://api.example', fakeAuth('tok')).assign('gh:1', 'editor');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/apps/my%20app/roles');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ userId: 'gh:1', role: 'editor' });
  });

  it('revoke drops the session on 401 and throws', async () => {
    mockFetch(401);
    const auth = fakeAuth('tok');
    await expect(new Roles('a', 'https://api.example', auth).revoke('gh:1', 'x')).rejects.toThrow(
      'Not signed in.',
    );
    expect(auth.handleUnauthorized).toHaveBeenCalledWith('tok');
  });

  it('check and myRoles stay soft: false / [] when signed out or refused', async () => {
    const fetchMock = mockFetch(403);
    const signedOut = new Roles('a', 'https://api.example', fakeAuth(null));
    expect(await signedOut.check('editor')).toBe(false);
    expect(await signedOut.myRoles()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    const roles = new Roles('a', 'https://api.example', fakeAuth('tok'));
    expect(await roles.check('editor')).toBe(false);
    expect(await roles.myRoles()).toEqual([]);
  });

  it('check reports 401 to auth', async () => {
    mockFetch(401);
    const auth = fakeAuth('tok');
    expect(await new Roles('a', 'https://api.example', auth).check('editor')).toBe(false);
    expect(auth.handleUnauthorized).toHaveBeenCalledWith('tok');
  });

  it('list asks the server for one role', async () => {
    const fetchMock = mockFetch(200, {
      roles: [{ userId: 'u1', roleName: 'editor', grantedBy: null, grantedAt: 1 }],
      nextOffset: null,
    });
    const list = await new Roles('a', 'https://api.example', fakeAuth('tok')).list('editor');
    expect(list.map((r) => r.userId)).toEqual(['u1']);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.example/v1/apps/a/roles?role=editor&offset=0',
    );
  });

  it('listAll follows nextOffset across pages (#765)', async () => {
    const page = (ids: string[], nextOffset: number | null) =>
      new Response(
        JSON.stringify({
          roles: ids.map((userId) => ({
            userId,
            roleName: 'member',
            grantedBy: null,
            grantedAt: 1,
          })),
          nextOffset,
        }),
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(['u1', 'u2'], 2))
      .mockResolvedValueOnce(page(['u3'], null));
    globalThis.fetch = fetchMock;
    const all = await new Roles('a', 'https://api.example', fakeAuth('tok')).listAll();
    expect(all.map((r) => r.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.example/v1/apps/a/roles?offset=0',
      'https://api.example/v1/apps/a/roles?offset=2',
    ]);
  });
});
