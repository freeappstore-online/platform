import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signPayload, signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: { appExists?: boolean; user?: Record<string, unknown> | null } = {}) {
  const { appExists = true, user = { github_login: 'alice' } } = opts;
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const result = {
        first: async () => {
          if (trimmed.includes('FROM apps')) return appExists ? { ok: 1 } : null;
          if (trimmed.includes('FROM users')) return user;
          return null;
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return { ...result, bind: (..._a: unknown[]) => result };
    },
  } as unknown as D1Database;
}

// A ROOM namespace stub whose stub.fetch echoes a sentinel so we can assert the
// request reached the Durable Object (i.e. auth passed).
function fakeRoom(captured: { url?: string } = {}) {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (url: string) => {
        captured.url = url;
        // The real DO returns a 101 WebSocket response; the Response constructor
        // forbids status 101, so use 200 as a "reached the DO" sentinel.
        return new Response('joined', { status: 200 });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: fakeDB(),
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ROOM: fakeRoom(),
    ...overrides,
  };
}

async function bearer(uid = 'u1') {
  return `Bearer ${await signSession(uid, SIGNING_KEY)}`;
}

describe('rooms: ticket issuance', () => {
  it('401s without auth', async () => {
    const res = await app.request('/v1/apps/timer/rooms/lobby/ticket', { method: 'POST' }, env());
    expect(res.status).toBe(401);
  });

  it('issues a ticket for an authenticated user', async () => {
    const res = await app.request(
      '/v1/apps/timer/rooms/lobby/ticket',
      { method: 'POST', headers: { Authorization: await bearer() } },
      env(),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ticket: string };
    expect(typeof data.ticket).toBe('string');
  });

  it('404s the ticket for an unknown app', async () => {
    const res = await app.request(
      '/v1/apps/nope/rooms/lobby/ticket',
      { method: 'POST', headers: { Authorization: await bearer() } },
      env({ DB: fakeDB({ appExists: false }) }),
    );
    expect(res.status).toBe(404);
  });
});

describe('rooms: websocket join', () => {
  it('400s without the websocket upgrade header', async () => {
    const res = await app.request('/v1/apps/timer/rooms/lobby?ticket=x', {}, env());
    expect(res.status).toBe(400);
  });

  it('rejects a ticket bound to a different room', async () => {
    const ticket = await signPayload(
      {
        typ: 'room',
        appId: 'timer',
        roomId: 'other',
        uid: 'u1',
        login: 'alice',
        exp: 2_000_000_000,
      },
      SIGNING_KEY,
    );
    const res = await app.request(
      `/v1/apps/timer/rooms/lobby?ticket=${ticket}`,
      { headers: { upgrade: 'websocket' } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it('rejects an expired ticket', async () => {
    const ticket = await signPayload(
      { typ: 'room', appId: 'timer', roomId: 'lobby', uid: 'u1', login: 'alice', exp: 1 },
      SIGNING_KEY,
    );
    const res = await app.request(
      `/v1/apps/timer/rooms/lobby?ticket=${ticket}`,
      { headers: { upgrade: 'websocket' } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it('accepts a valid ticket and forwards to the room DO with uid/login (no credential)', async () => {
    const ticket = await signPayload(
      {
        typ: 'room',
        appId: 'timer',
        roomId: 'lobby',
        uid: 'u1',
        login: 'alice',
        exp: 2_000_000_000,
      },
      SIGNING_KEY,
    );
    const captured: { url?: string } = {};
    const res = await app.request(
      `/v1/apps/timer/rooms/lobby?ticket=${ticket}`,
      { headers: { upgrade: 'websocket' } },
      env({ ROOM: fakeRoom(captured) }),
    );
    expect(res.status).toBe(200);
    expect(captured.url).toContain('uid=u1');
    expect(captured.url).toContain('login=alice');
    // The ticket must NOT be forwarded to the DO.
    expect(captured.url).not.toContain('ticket=');
  });
});
