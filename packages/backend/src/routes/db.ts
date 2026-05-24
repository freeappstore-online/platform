import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

/**
 * Collections — a simple document database for apps.
 *
 * Documents are JSON objects stored per (appId, collection, id).
 * Write operations require auth; reads are public.
 * Updates and deletes are owner-only.
 *
 * Limits:
 * - collection names ≤ 64 chars, alphanumeric + hyphens + underscores
 * - max 10,000 documents per collection per app
 * - max 64KB per document
 */
const MAX_COLLECTION_LENGTH = 64;
const MAX_DOCS_PER_COLLECTION = 10_000;
const MAX_DOC_BYTES = 64 * 1024;
const COLLECTION_RE = /^[a-zA-Z0-9_-]+$/;

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}${rand}`;
}

function validateCollection(name: string): string | null {
  if (!name || name.length > MAX_COLLECTION_LENGTH) {
    return `collection name must be 1-${MAX_COLLECTION_LENGTH} chars`;
  }
  if (!COLLECTION_RE.test(name)) {
    return 'collection name must be alphanumeric, hyphens, or underscores';
  }
  return null;
}

export const dbRoutes = new Hono<{ Bindings: Env }>();

/** Create a document. Auth required. */
dbRoutes.post('/apps/:appId/db/:collection', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, collection } = c.req.param();

    const colErr = validateCollection(collection);
    if (colErr) return c.text(colErr, 400);

    const body = await c.req.text();
    if (body.length > MAX_DOC_BYTES) {
      return c.text(`document exceeds ${MAX_DOC_BYTES} bytes`, 413);
    }

    // Validate JSON
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return c.text('invalid JSON', 400);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return c.text('document must be a JSON object', 400);
    }

    // Check collection document limit
    const count = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM documents WHERE app_id = ? AND collection = ?',
    )
      .bind(appId, collection)
      .first<{ cnt: number }>();
    if ((count?.cnt ?? 0) >= MAX_DOCS_PER_COLLECTION) {
      return c.text(`max ${MAX_DOCS_PER_COLLECTION} documents per collection`, 413);
    }

    const id = generateId();
    const now = Date.now();

    await c.env.DB.prepare(
      `INSERT INTO documents (app_id, collection, id, data, owner_id, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'public', ?, ?)`,
    )
      .bind(appId, collection, id, body, user.id, now, now)
      .run();

    return c.json({ id, ...data }, 201);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/** List/query documents. Public read. */
dbRoutes.get('/apps/:appId/db/:collection', async (c) => {
  const { appId, collection } = c.req.param();

  const colErr = validateCollection(collection);
  if (colErr) return c.text(colErr, 400);

  const owner = c.req.query('owner');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const orderBy = c.req.query('orderBy') === 'updated_at' ? 'updated_at' : 'created_at';
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';

  let whereClause = 'WHERE app_id = ? AND collection = ?';
  const bindings: unknown[] = [appId, collection];

  if (owner) {
    whereClause += ' AND owner_id = ?';
    bindings.push(owner);
  }

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM documents ${whereClause}`,
  )
    .bind(...bindings)
    .first<{ total: number }>();

  const { results } = await c.env.DB.prepare(
    `SELECT id, data, owner_id, created_at, updated_at FROM documents ${whereClause} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...bindings, limit, offset)
    .all<{ id: string; data: string; owner_id: string; created_at: number; updated_at: number }>();

  const documents = results.map((r) => ({
    id: r.id,
    ...(JSON.parse(r.data) as Record<string, unknown>),
    _owner: r.owner_id,
    _createdAt: r.created_at,
    _updatedAt: r.updated_at,
  }));

  return c.json({ documents, total: countResult?.total ?? 0 });
});

/** Get a single document. Public read. */
dbRoutes.get('/apps/:appId/db/:collection/:id', async (c) => {
  const { appId, collection, id } = c.req.param();

  const colErr = validateCollection(collection);
  if (colErr) return c.text(colErr, 400);

  const row = await c.env.DB.prepare(
    'SELECT id, data, owner_id, created_at, updated_at FROM documents WHERE app_id = ? AND collection = ? AND id = ?',
  )
    .bind(appId, collection, id)
    .first<{
      id: string;
      data: string;
      owner_id: string;
      created_at: number;
      updated_at: number;
    }>();

  if (!row) return c.text('not found', 404);

  return c.json({
    id: row.id,
    ...(JSON.parse(row.data) as Record<string, unknown>),
    _owner: row.owner_id,
    _createdAt: row.created_at,
    _updatedAt: row.updated_at,
  });
});

/** Update a document. Auth required, owner only. */
dbRoutes.put('/apps/:appId/db/:collection/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, collection, id } = c.req.param();

    const colErr = validateCollection(collection);
    if (colErr) return c.text(colErr, 400);

    const existing = await c.env.DB.prepare(
      'SELECT data, owner_id, created_at FROM documents WHERE app_id = ? AND collection = ? AND id = ?',
    )
      .bind(appId, collection, id)
      .first<{ data: string; owner_id: string; created_at: number }>();

    if (!existing) return c.text('not found', 404);
    if (existing.owner_id !== user.id) return c.text('forbidden', 403);

    const body = await c.req.text();
    if (body.length > MAX_DOC_BYTES) {
      return c.text(`document exceeds ${MAX_DOC_BYTES} bytes`, 413);
    }

    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return c.text('invalid JSON', 400);
    }
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return c.text('patch must be a JSON object', 400);
    }

    const existingData = JSON.parse(existing.data) as Record<string, unknown>;
    const merged = { ...existingData, ...patch };
    const mergedJson = JSON.stringify(merged);

    if (mergedJson.length > MAX_DOC_BYTES) {
      return c.text(`merged document exceeds ${MAX_DOC_BYTES} bytes`, 413);
    }

    const now = Date.now();

    await c.env.DB.prepare(
      'UPDATE documents SET data = ?, updated_at = ? WHERE app_id = ? AND collection = ? AND id = ?',
    )
      .bind(mergedJson, now, appId, collection, id)
      .run();

    return c.json({
      id,
      ...merged,
      _owner: existing.owner_id,
      _createdAt: existing.created_at,
      _updatedAt: now,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/** Delete a document. Auth required, owner only. */
dbRoutes.delete('/apps/:appId/db/:collection/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, collection, id } = c.req.param();

    const colErr = validateCollection(collection);
    if (colErr) return c.text(colErr, 400);

    const existing = await c.env.DB.prepare(
      'SELECT owner_id FROM documents WHERE app_id = ? AND collection = ? AND id = ?',
    )
      .bind(appId, collection, id)
      .first<{ owner_id: string }>();

    if (!existing) return c.text('not found', 404);
    if (existing.owner_id !== user.id) return c.text('forbidden', 403);

    await c.env.DB.prepare('DELETE FROM documents WHERE app_id = ? AND collection = ? AND id = ?')
      .bind(appId, collection, id)
      .run();

    return c.body(null, 204);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});
