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
  if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);

  const ticket = await signPayload<RoomTicket>(
    {
      typ: 'room',
      appId,
      roomId,
      uid: user.id,
      login: user.githubLogin,
      exp: Math.floor(Date.now() / 1000) + ROOM_TICKET_TTL_SECONDS,
    },
    c.env.SESSION_SIGNING_KEY,
  );
  return c.json({ ticket, expiresInSeconds: ROOM_TICKET_TTL_SECONDS });
});

roomRoutes.get('/apps/:appId/rooms/:roomId', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 400);
  const { appId, roomId } = c.req.param();

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
