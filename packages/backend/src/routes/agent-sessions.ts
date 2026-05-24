/**
 * VibeCode agent sessions — persistent project + message storage in D1.
 * Replaces localStorage (per-device) and DO SQLite (evicts after 24h).
 *
 * GET    /v1/agent/sessions              — list user's sessions
 * GET    /v1/agent/sessions/:id          — get session with messages
 * PUT    /v1/agent/sessions/:id          — create or update session
 * PUT    /v1/agent/sessions/:id/messages — update messages only
 * DELETE /v1/agent/sessions/:id          — delete session
 */

import { Hono } from 'hono';
import { requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

export const agentSessionRoutes = new Hono<{ Bindings: Env }>();

// ── List sessions ───────────────────────────────────────────────

agentSessionRoutes.get('/agent/sessions', async (c) => {
  const user = await requireUser(c);
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);

  const result = await c.env.DB.prepare(
    `SELECT session_id, name, app_id, app_url, deployed, created_at, updated_at
     FROM agent_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
  ).bind(user.id, limit).all();

  return c.json({
    sessions: (result.results ?? []).map((r: Record<string, unknown>) => ({
      id: r.session_id,
      name: r.name,
      appId: r.app_id,
      appUrl: r.app_url,
      deployed: r.deployed === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// ── Get session with messages ───────────────────────────────────

agentSessionRoutes.get('/agent/sessions/:id', async (c) => {
  const user = await requireUser(c);
  const sessionId = c.req.param('id')!;

  const row = await c.env.DB.prepare(
    'SELECT * FROM agent_sessions WHERE session_id = ? AND user_id = ?',
  ).bind(sessionId, user.id).first<Record<string, unknown>>();

  if (!row) return c.json({ session: null });

  return c.json({
    session: {
      id: row.session_id,
      name: row.name,
      appId: row.app_id,
      appUrl: row.app_url,
      deployed: row.deployed === 1,
      messages: row.messages ? JSON.parse(row.messages as string) : [],
      deployState: row.deploy_state ? JSON.parse(row.deploy_state as string) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
});

// ── Create or update session ────────────────────────────────────

agentSessionRoutes.put('/agent/sessions/:id', async (c) => {
  const user = await requireUser(c);
  const sessionId = c.req.param('id')!;
  const body = await c.req.json<{
    name?: string;
    appId?: string;
    appUrl?: string;
    deployed?: boolean;
    messages?: unknown[];
    deployState?: unknown;
  }>().catch(() => null);

  if (!body) return c.json({ error: 'invalid body' }, 400);

  // Verify ownership: if a session with this ID already exists, it must belong to this user
  const existing = await c.env.DB.prepare(
    'SELECT user_id FROM agent_sessions WHERE session_id = ?',
  ).bind(sessionId).first<{ user_id: string }>();
  if (existing && existing.user_id !== user.id) {
    return c.json({ error: 'session belongs to another user' }, 403);
  }

  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO agent_sessions (session_id, user_id, name, app_id, app_url, deployed, messages, deploy_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       name = COALESCE(excluded.name, agent_sessions.name),
       app_id = COALESCE(excluded.app_id, agent_sessions.app_id),
       app_url = COALESCE(excluded.app_url, agent_sessions.app_url),
       deployed = COALESCE(excluded.deployed, agent_sessions.deployed),
       messages = COALESCE(excluded.messages, agent_sessions.messages),
       deploy_state = COALESCE(excluded.deploy_state, agent_sessions.deploy_state),
       updated_at = excluded.updated_at`,
  ).bind(
    sessionId,
    user.id,
    body.name ?? 'New App',
    body.appId ?? null,
    body.appUrl ?? null,
    body.deployed ? 1 : 0,
    body.messages ? JSON.stringify(body.messages) : null,
    body.deployState ? JSON.stringify(body.deployState) : null,
    now,
    now,
  ).run();

  return c.json({ ok: true });
});

// ── Update messages only (called frequently during chat) ────────

agentSessionRoutes.put('/agent/sessions/:id/messages', async (c) => {
  const user = await requireUser(c);
  const sessionId = c.req.param('id')!;
  const body = await c.req.json<{ messages: unknown[] }>().catch(() => null);

  if (!body?.messages) return c.json({ error: 'messages required' }, 400);

  // Cap message size to prevent storage abuse (300 messages, ~500KB typical max)
  const messages = Array.isArray(body.messages) ? body.messages.slice(-300) : [];
  const json = JSON.stringify(messages);
  if (json.length > 2_000_000) return c.json({ error: 'messages too large (max 2MB)' }, 413);

  await c.env.DB.prepare(
    `UPDATE agent_sessions SET messages = ?, updated_at = ? WHERE session_id = ? AND user_id = ?`,
  ).bind(json, Date.now(), sessionId, user.id).run();

  return c.json({ ok: true });
});

// ── Delete session ──────────────────────────────────────────────

agentSessionRoutes.delete('/agent/sessions/:id', async (c) => {
  const user = await requireUser(c);
  const sessionId = c.req.param('id')!;

  await c.env.DB.prepare(
    'DELETE FROM agent_sessions WHERE session_id = ? AND user_id = ?',
  ).bind(sessionId, user.id).run();

  return c.json({ ok: true });
});
