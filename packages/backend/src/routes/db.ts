import { Hono } from 'hono';
import { appExists } from '../lib/apps.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { queryLimit, queryOffset } from '../lib/paging.js';
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

/** Validate a JSON field name for use in json_extract paths. Alphanumeric + underscore only. */
function sanitizeJsonField(name: string): string | null {
  if (!name || name.length > 32 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return null;
  return name;
}

/**
 * Server id and row metadata win over same-named fields stored in the JSON
 * body. Spreading the body first matches the create response, which already
 * puts `id` last so a client-supplied `data.id` cannot shadow the row id.
 */
function withDocumentMeta(
  id: string,
  data: Record<string, unknown>,
  meta: { ownerId: string; createdAt: number; updatedAt: number },
) {
  return {
    ...data,
    id,
    _owner: meta.ownerId,
    _createdAt: meta.createdAt,
    _updatedAt: meta.updatedAt,
  };
}

export const dbRoutes = new Hono<{ Bindings: Env }>();

/** Create a document. Auth required. */
dbRoutes.post('/apps/:appId/db/:collection', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, collection } = c.req.param();

    const colErr = validateCollection(collection);
    if (colErr) return c.text(colErr, 400);
    if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);

    const body = await c.req.text();
    // Measure UTF-8 bytes: D1 stores TEXT as UTF-8, so `body.length` (UTF-16
    // code units) under-counts multibyte content and lets the cap be exceeded.
    if (new TextEncoder().encode(body).length > MAX_DOC_BYTES) {
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

    // Re-check the cap in the insert itself (#277): parallel creates that all
    // passed the count above can't take a collection past it.
    const write = await c.env.DB.prepare(
      `INSERT INTO documents (app_id, collection, id, data, owner_id, visibility, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'public', ?, ?
       WHERE (SELECT COUNT(*) FROM documents WHERE app_id = ? AND collection = ?) < ?`,
    )
      .bind(
        appId,
        collection,
        id,
        body,
        user.id,
        now,
        now,
        appId,
        collection,
        MAX_DOCS_PER_COLLECTION,
      )
      .run();
    if (!write.meta.changes) {
      return c.text(`max ${MAX_DOCS_PER_COLLECTION} documents per collection`, 413);
    }

    // `id` last: a client-supplied `data.id` must not shadow the server id in
    // the response (the row is stored under the generated id).
    return c.json({ ...data, id }, 201);
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
  const limit = queryLimit(c.req.query('limit'), 20, 100);
  const offset = queryOffset(c.req.query('offset'));
  const orderBy = c.req.query('orderBy') === 'updated_at' ? 'updated_at' : 'created_at';
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';

  let whereClause = 'WHERE app_id = ? AND collection = ?';
  const bindings: unknown[] = [appId, collection];

  if (owner) {
    whereClause += ' AND owner_id = ?';
    bindings.push(owner);
  }

  // Geo bounding box — filter documents by JSON fields.
  // Usage: ?lat_min=X&lat_max=Y&lon_min=X&lon_max=Y&lat_field=lat&lon_field=lon
  // Fields default to 'lat' and 'lon'.
  const latMin = c.req.query('lat_min');
  const latMax = c.req.query('lat_max');
  const lonMin = c.req.query('lon_min');
  const lonMax = c.req.query('lon_max');
  if (latMin != null && latMax != null && lonMin != null && lonMax != null) {
    const latF = sanitizeJsonField(c.req.query('lat_field') || 'lat');
    const lonF = sanitizeJsonField(c.req.query('lon_field') || 'lon');
    if (!latF || !lonF) return c.text('invalid field name', 400);
    const lats = [parseFloat(latMin), parseFloat(latMax)];
    const lons = [parseFloat(lonMin), parseFloat(lonMax)];
    if (lats.some(Number.isNaN) || lons.some(Number.isNaN))
      return c.text('bbox params must be numbers', 400);
    whereClause += ` AND json_extract(data, '$.${latF}') BETWEEN ? AND ?`;
    whereClause += ` AND json_extract(data, '$.${lonF}') BETWEEN ? AND ?`;
    bindings.push(lats[0], lats[1], lons[0], lons[1]);
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

  const documents = results.map((r) =>
    withDocumentMeta(r.id, JSON.parse(r.data) as Record<string, unknown>, {
      ownerId: r.owner_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );

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

  return c.json(
    withDocumentMeta(row.id, JSON.parse(row.data) as Record<string, unknown>, {
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
});

/** Update a document. Auth required, owner only. */
dbRoutes.put('/apps/:appId/db/:collection/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, collection, id } = c.req.param();

    const colErr = validateCollection(collection);
    if (colErr) return c.text(colErr, 400);

    const body = await c.req.text();
    if (new TextEncoder().encode(body).length > MAX_DOC_BYTES) {
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

    // Read-merge-write as compare-and-set (#277): the UPDATE only applies if
    // the document is still what we merged into. If a concurrent PUT changed
    // it first, re-read and merge again, so neither patch is lost.
    let existing: { data: string; owner_id: string; created_at: number } | null = null;
    let merged: Record<string, unknown> = {};
    let now = 0;
    for (let attempt = 0; ; attempt++) {
      existing = await c.env.DB.prepare(
        'SELECT data, owner_id, created_at FROM documents WHERE app_id = ? AND collection = ? AND id = ?',
      )
        .bind(appId, collection, id)
        .first<{ data: string; owner_id: string; created_at: number }>();

      if (!existing) return c.text('not found', 404);
      if (existing.owner_id !== user.id) return c.text('forbidden', 403);

      const existingData = JSON.parse(existing.data) as Record<string, unknown>;
      merged = { ...existingData, ...patch };
      const mergedJson = JSON.stringify(merged);

      if (new TextEncoder().encode(mergedJson).length > MAX_DOC_BYTES) {
        return c.text(`merged document exceeds ${MAX_DOC_BYTES} bytes`, 413);
      }

      now = Date.now();
      const write = await c.env.DB.prepare(
        'UPDATE documents SET data = ?, updated_at = ? WHERE app_id = ? AND collection = ? AND id = ? AND data = ?',
      )
        .bind(mergedJson, now, appId, collection, id, existing.data)
        .run();
      if (write.meta.changes) break;
      if (attempt === 4) return c.text('document is being updated concurrently; retry', 409);
    }

    return c.json(
      withDocumentMeta(id, merged, {
        ownerId: existing.owner_id,
        createdAt: existing.created_at,
        updatedAt: now,
      }),
    );
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
