import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signPayload, signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';

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

// #278: room ids are bounded and an app has at most 64 live rooms.
describe('rooms: room id validation', () => {
  it.each(['a'.repeat(65), 'has space', 'a/b', '..%2Fx'])(
    '400s room id %j at ticket and connect',
    async (roomId) => {
      const path = `/v1/apps/timer/rooms/${encodeURIComponent(roomId)}`;
      const ticket = await app.request(
        `${path}/ticket`,
        { method: 'POST', headers: { Authorization: await bearer() } },
        env(),
      );
      expect(ticket.status).toBe(400);
      const ws = await app.request(`${path}?token=x`, { headers: { Upgrade: 'websocket' } }, env());
      expect(ws.status).toBe(400);
    },
  );

  it.each(['canvas', 'canvas-main', 'a1b2c3d4', 'Session_42', 'game:lobby.v2'])(
    'accepts room id %s',
    async (roomId) => {
      const res = await app.request(
        `/v1/apps/timer/rooms/${roomId}/ticket`,
        { method: 'POST', headers: { Authorization: await bearer() } },
        env(),
      );
      expect(res.status).toBe(200);
    },
  );
});

describe.skipIf(!hasSqlite)('rooms: 64 live rooms per app', () => {
  async function setup(liveRooms: number, staleRooms = 0) {
    const { db, d1 } = sqliteD1();
    const now = Date.now();
    db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)',
    ).run('u1', 1, 'alice', now);
    db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, ?)').run(
      'timer',
      'alice',
      now,
    );
    const ins = db.prepare('INSERT INTO app_rooms (app_id, room_id, last_active) VALUES (?, ?, ?)');
    for (let i = 0; i < liveRooms; i++) ins.run('timer', `r${i}`, now);
    for (let i = 0; i < staleRooms; i++) ins.run('timer', `old${i}`, now - 25 * 60 * 60 * 1000);
    const e = env({ DB: d1 });
    const ticket = async (roomId: string) =>
      (
        await app.request(
          `/v1/apps/timer/rooms/${roomId}/ticket`,
          { method: 'POST', headers: { Authorization: await bearer() } },
          e,
        )
      ).status;
    const token = await signSession('u1', SIGNING_KEY);
    const connect = async (roomId: string) =>
      (
        await app.request(
          `/v1/apps/timer/rooms/${roomId}?token=${token}`,
          { headers: { Upgrade: 'websocket' } },
          e,
        )
      ).status;
    return { db, ticket, connect };
  }

  it('refuses a 65th room but keeps existing rooms working', async () => {
    const { ticket } = await setup(64);
    expect(await ticket('new-room')).toBe(429);
    expect(await ticket('r10')).toBe(200);
  });

  it('refuses a new room on connect too (the old token path skips tickets)', async () => {
    const { connect } = await setup(64);
    expect(await connect('new-room')).toBe(429);
    expect(await connect('r3')).toBe(200); // reached the room DO
  });

  it('rooms idle for over 24h stop counting', async () => {
    const { ticket } = await setup(63, 10);
    expect(await ticket('new-room')).toBe(200);
    expect(await ticket('one-more')).toBe(429);
  });

  it('10 parallel new rooms at 63/64: exactly one is created', async () => {
    const { db, ticket } = await setup(63);
    const statuses = await Promise.all(Array.from({ length: 10 }, (_, i) => ticket(`p${i}`)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM app_rooms WHERE app_id = 'timer'").get() as {
          n: number;
        }
      ).n,
    ).toBe(64);
  });
});
