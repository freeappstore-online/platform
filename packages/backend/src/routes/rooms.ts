import { Hono } from 'hono';
import { appExists } from '../lib/apps.js';
import { requireUser } from '../lib/auth.js';
import { signPayload, verifyPayload, verifySession } from '../lib/session.js';
import type { Env } from '../types.js';

export const roomRoutes = new Hono<{ Bindings: Env }>();

interface RoomTicket {
  typ: 'room';
  appId: string;
  roomId: string;
  uid: string;
  login: string;
  exp: number; // unix seconds
}

const ROOM_TICKET_TTL_SECONDS = 30;

// Room ids are app-chosen names (`canvas`, a session code). Bound them so a
// name can't smuggle path segments or grow without limit (#278).
const ROOM_ID_RE = /^[A-Za-z0-9._~:@-]{1,64}$/;
export const MAX_ROOMS_PER_APP = 64;
// Same window as the Room DO's idle eviction (do/room.ts IDLE_EVICT_MS).
const ROOM_LIVE_MS = 24 * 60 * 60 * 1000;

/**
 * Register use of a room, or refuse a new one when the app already has
 * MAX_ROOMS_PER_APP live rooms. One statement, so parallel claims can't
 * overshoot the cap. Rooms idle past ROOM_LIVE_MS stop counting.
 */
export async function claimRoom(env: Env, appId: string, roomId: string): Promise<boolean> {
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO app_rooms (app_id, room_id, last_active)
     SELECT ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM app_rooms WHERE app_id = ? AND room_id = ?)
        OR (SELECT COUNT(*) FROM app_rooms WHERE app_id = ? AND last_active > ?) < ?
     ON CONFLICT(app_id, room_id) DO UPDATE SET last_active = excluded.last_active`,
  )
    .bind(appId, roomId, now, appId, roomId, appId, now - ROOM_LIVE_MS, MAX_ROOMS_PER_APP)
    .run();
  return !!r.meta.changes;
}

const ROOM_LIMIT_MESSAGE = `room limit reached: an app can have ${MAX_ROOMS_PER_APP} active rooms`;

/**
 * Issue a short-lived, room-scoped WebSocket ticket.
 *
 * Authenticated via the normal `Authorization` header (never a URL), so the
 * account-wide session token — which grants full access on every FAS app on the
 * origin — stays out of WebSocket URLs. WS connect URLs routinely land in CF
 * edge / Durable Object / reverse-proxy access logs; a leaked ticket is useless
 * after 30s and only grants this one room.
 */
roomRoutes.post('/apps/:appId/rooms/:roomId/ticket', async (c) => {
  const user = await requireUser(c);
  const { appId, roomId } = c.req.param();
  if (!ROOM_ID_RE.test(roomId)) return c.text('invalid room id', 400);
  if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);
  if (!(await claimRoom(c.env, appId, roomId))) return c.text(ROOM_LIMIT_MESSAGE, 429);

  const ticket = await signPayload<RoomTicket>(
    {
      typ: 'room',
      appId,
      roomId,
      uid: user.id,
      login: user.githubLogin || user.login,
      exp: Math.floor(Date.now() / 1000) + ROOM_TICKET_TTL_SECONDS,
    },
    c.env.SESSION_SIGNING_KEY,
  );
  return c.json({ ticket, expiresInSeconds: ROOM_TICKET_TTL_SECONDS });
});

roomRoutes.get('/apps/:appId/rooms/:roomId', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 400);
  const { appId, roomId } = c.req.param();
  if (!ROOM_ID_RE.test(roomId)) return c.text('invalid room id', 400);

  let uid: string;
  let login: string;

  const ticketStr = c.req.query('ticket');
  if (ticketStr) {
    // Preferred path: a short-lived room ticket. Verify signature, binding to
    // this exact app+room, and expiry.
    const t = await verifyPayload<RoomTicket>(ticketStr, c.env.SESSION_SIGNING_KEY);
    if (!t || t.typ !== 'room' || t.appId !== appId || t.roomId !== roomId) {
      return c.text('invalid ticket', 401);
    }
    if (t.exp * 1000 < Date.now()) return c.text('ticket expired', 401);
    uid = t.uid;
    login = t.login;
  } else {
    // Deprecated fallback: session token in the URL (old SDKs). Kept so
    // already-deployed apps keep working; new clients use tickets. Remove once
    // the fleet has rebuilt against the ticket-based SDK.
    const token = c.req.query('token');
    if (!token) return c.text('missing ticket', 401);
    const session = await verifySession(token, c.env.SESSION_SIGNING_KEY);
    if (!session) return c.text('invalid session', 401);
    if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);
    const user = await c.env.DB.prepare('SELECT github_login FROM users WHERE id = ?')
      .bind(session.uid)
      .first<{ github_login: string }>();
    uid = session.uid;
    login = user?.github_login ?? '';
  }

  // Checked here too: the deprecated token path above opens rooms without a ticket.
  if (!(await claimRoom(c.env, appId, roomId))) return c.text(ROOM_LIMIT_MESSAGE, 429);

  const id = c.env.ROOM.idFromName(`${appId}:${roomId}`);
  const stub = c.env.ROOM.get(id);
  const url = new URL(c.req.url);
  // Don't forward the credential to the DO; hand it the resolved identity.
  url.searchParams.delete('ticket');
  url.searchParams.delete('token');
  url.searchParams.set('uid', uid);
  url.searchParams.set('login', login);
  return stub.fetch(url.toString(), c.req.raw);
});
