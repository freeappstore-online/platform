/**
 * Community generation (#727, #728). The app owner publishes sets (model,
 * version, params) and jobs (key + input); signed-in users' devices claim a
 * job under a lease, generate locally and upload into private quarantine. Only
 * the verifier promotes a submission, through acceptSubmission(), into a
 * write-once public artifact. See docs/community-generation.md.
 */
import { type Context, Hono } from 'hono';
import { APP_ID_RE } from '../lib/apps.js';
import { FAS_APP_ROWS, HttpError, requireAppOwner, requireAppUser } from '../lib/auth.js';
import { verifyGithubOidc } from '../lib/github-oidc.js';
import { nativeBody, nativeDevice, nativeHash, nativeRandom } from '../lib/native-companion.js';
import { d1UsageStore, dayKey } from '../lib/proxy-rate-limit.js';
import type { Env } from '../types.js';
import { APP_ORG_ID, DEPLOY_AUDIENCE } from './deploy.js';

type Ctx = Context<{ Bindings: Env }>;

export const GENERATION_LIMITS = {
  leaseMs: 15 * 60_000,
  userDaily: 200,
  appDaily: 5_000,
  jobsPerRequest: 500,
  textChars: 10_000,
  maxBytes: 25_000_000,
  metaBytes: 64 * 1024,
  models: 20,
  /** Quarantine objects expire after 7 days (R2 lifecycle); stop waiting a day earlier. */
  pendingMs: 6 * 24 * 60 * 60_000,
};
const FORMATS = ['audio/mp4', 'audio/ogg', 'audio/wav'];
const KEY_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const NAME_RE = /^[A-Za-z0-9._:/@+-]{1,120}$/;

export interface SetRow {
  id: string;
  app_id: string;
  kind: 'tts';
  model: string;
  model_version: string;
  params: string;
  formats: string;
  max_bytes: number;
  replicas: number;
  require_attestation: number;
  created_by: string;
  created_at: number;
}
type JobJoin = Pick<SetRow, 'model' | 'model_version' | 'params' | 'formats' | 'max_bytes'> & {
  set_id: string;
  key: string;
  input: string;
};
export interface SubmissionRow {
  id: string;
  job_id: string;
  set_id: string;
  app_id: string;
  user_id: string;
  device_kind: string;
  attestation: string;
  object_key: string;
  meta_key: string | null;
  bytes: number;
  content_type: string;
  sha256: string;
  created_at: number;
}
interface ArtifactRow {
  job_id: string;
  set_id: string;
  app_id: string;
  key: string;
  submission_id: string;
  object_key: string;
  meta_key: string | null;
  bytes: number;
  content_type: string;
  duration_ms: number | null;
  sha256: string;
  model: string;
  model_version: string;
  accepted_at: number;
}

export const generationRoutes = new Hono<{ Bindings: Env }>();

generationRoutes.use('/apps/:appId/generation/*', async (c, next) => {
  const id = c.req.param('appId')!;
  if (!APP_ID_RE.test(id)) return c.text('unknown app', 404);
  const exists = await c.env.DB.prepare(`SELECT 1 FROM apps WHERE id = ? AND ${FAS_APP_ROWS}`)
    .bind(id)
    .first();
  if (!exists) return c.text('unknown app', 404);
  if (!c.env.GENERATED) return c.text('generation storage unavailable', 503);
  c.header('Cache-Control', 'private, no-store');
  await next();
});

function setInfo(row: SetRow) {
  return {
    id: row.id,
    appId: row.app_id,
    kind: row.kind,
    model: row.model,
    modelVersion: row.model_version,
    params: JSON.parse(row.params),
    formats: JSON.parse(row.formats),
    maxBytes: row.max_bytes,
    replicas: row.replicas,
    requireAttestation: !!row.require_attestation,
    createdAt: row.created_at,
  };
}

const setRow = (db: D1Database, appId: string, setId: string) =>
  db
    .prepare('SELECT * FROM generation_sets WHERE id = ? AND app_id = ?')
    .bind(setId, appId)
    .first<SetRow>();

const audit = (db: D1Database, appId: string, actor: string, action: string, target: string) =>
  db
    .prepare(
      'INSERT INTO generation_audit (app_id, actor, action, target, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(appId, actor, action, target, Date.now());

/**
 * The app owner's session, or GitHub Actions OIDC from the app's pinned repo
 * on main (the repo its keyless deploys come from), so CI can publish jobs.
 */
async function owner(c: Ctx, appId: string): Promise<string> {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (token.split('.').length !== 3) return (await requireAppOwner(c, appId)).id;
  let claims;
  try {
    claims = await verifyGithubOidc(token, { audience: DEPLOY_AUDIENCE });
  } catch (e) {
    throw new HttpError(401, `OIDC verification failed: ${(e as Error).message}`);
  }
  if (claims.repository_owner_id !== APP_ORG_ID || claims.ref !== 'refs/heads/main')
    throw new HttpError(403, 'only main of a freeappstore-online repository may manage jobs');
  const pinned = await c.env.DB.prepare(
    'SELECT 1 FROM app_repositories WHERE app_id = ? AND repository_id = ?',
  )
    .bind(appId, claims.repository_id ?? '')
    .first();
  if (!pinned) throw new HttpError(403, `${claims.repository} is not the repository of ${appId}`);
  return `repo:${claims.repository}`;
}

/** An app-audience session, or a native companion device (`ndev_`). */
async function contributor(c: Ctx, appId: string) {
  let id: string, device: 'web' | 'native';
  if (c.req.header('Authorization')?.startsWith('Bearer ndev_')) {
    const d = await nativeDevice(c);
    const user = await c.env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(d.user_id).first();
    if (!user) throw new HttpError(401, 'Account no longer exists.');
    id = d.user_id;
    device = 'native';
  } else {
    id = (await requireAppUser(c, appId)).id;
    device = 'web';
  }
  const blocked = await c.env.DB.prepare(
    'SELECT 1 FROM generation_blocks WHERE app_id = ? AND user_id = ?',
  )
    .bind(appId, id)
    .first();
  if (blocked) throw new HttpError(403, 'blocked from contributing to this app');
  return { id, device };
}

generationRoutes.post('/apps/:appId/generation/sets', async (c) => {
  const appId = c.req.param('appId');
  const actor = await owner(c, appId);
  const b = await nativeBody(c, 8192);
  const formats = b.formats;
  const params = JSON.stringify(b.params ?? {});
  if (
    b.kind !== 'tts' ||
    typeof b.model !== 'string' ||
    !NAME_RE.test(b.model) ||
    typeof b.modelVersion !== 'string' ||
    !NAME_RE.test(b.modelVersion) ||
    !b.params ||
    typeof b.params !== 'object' ||
    Array.isArray(b.params) ||
    params.length > 4096 ||
    !Array.isArray(formats) ||
    !formats.length ||
    formats.some((f) => !FORMATS.includes(f)) ||
    !Number.isSafeInteger(b.maxBytes) ||
    (b.maxBytes as number) < 1 ||
    (b.maxBytes as number) > GENERATION_LIMITS.maxBytes ||
    ![1, 2, 3].includes(b.replicas as number) ||
    (b.requireAttestation !== undefined && typeof b.requireAttestation !== 'boolean')
  ) {
    throw new HttpError(400, 'invalid generation set');
  }
  const row: SetRow = {
    id: crypto.randomUUID(),
    app_id: appId,
    kind: 'tts',
    model: b.model,
    model_version: b.modelVersion,
    params,
    formats: JSON.stringify([...new Set(formats)]),
    max_bytes: b.maxBytes as number,
    replicas: b.replicas as number,
    require_attestation: b.requireAttestation ? 1 : 0,
    created_by: actor,
    created_at: Date.now(),
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO generation_sets (id, app_id, kind, model, model_version, params, formats, max_bytes, replicas, require_attestation, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...Object.values(row)),
    audit(c.env.DB, appId, actor, 'set.create', row.id),
  ]);
  return c.json({ set: setInfo(row) }, 201);
});

generationRoutes.post('/apps/:appId/generation/sets/:setId/jobs', async (c) => {
  const appId = c.req.param('appId');
  await owner(c, appId);
  const set = await setRow(c.env.DB, appId, c.req.param('setId'));
  if (!set) throw new HttpError(404, 'set not found');
  const { jobs } = await nativeBody(c, 2_000_000);
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > GENERATION_LIMITS.jobsPerRequest)
    throw new HttpError(400, `send 1 to ${GENERATION_LIMITS.jobsPerRequest} jobs`);
  const keys = new Set<string>();
  const wanted: { id: string; key: string; input: string }[] = [];
  for (const j of jobs) {
    const text = j?.input?.text;
    if (
      typeof j?.key !== 'string' ||
      !KEY_RE.test(j.key) ||
      keys.has(j.key) ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > GENERATION_LIMITS.textChars
    ) {
      throw new HttpError(400, `invalid job ${JSON.stringify(j?.key ?? null)}`);
    }
    keys.add(j.key);
    const input = JSON.stringify({ text });
    const id = await nativeHash(
      JSON.stringify([set.id, j.key, input, set.model, set.model_version, set.params]),
    );
    wanted.push({ id, key: j.key, input });
  }
  const existing = () =>
    c.env.DB.prepare(
      'SELECT id, key, status FROM generation_jobs WHERE set_id = ? AND key IN (SELECT value FROM json_each(?))',
    )
      .bind(set.id, JSON.stringify([...keys]))
      .all<{ id: string; key: string; status: string }>();
  const conflicts = (rows: { id: string; key: string }[]) =>
    rows.filter((r) => wanted.find((w) => w.key === r.key)?.id !== r.id).map((r) => r.key);
  let changed = conflicts((await existing()).results);
  if (!changed.length) {
    await c.env.DB.prepare(
      `INSERT INTO generation_jobs (id, set_id, app_id, key, input, status, created_at)
       SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.key'), json_extract(value, '$.input'), 'open', ?
       FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`,
    )
      .bind(set.id, appId, Date.now(), JSON.stringify(wanted))
      .run();
  }
  const rows = (await existing()).results;
  // A concurrent request may have taken a key with another input.
  changed = changed.length ? changed : conflicts(rows);
  if (changed.length)
    return c.json({ error: 'a key already exists with a different input', keys: changed }, 409);
  return c.json({
    jobs: wanted.map((w) => ({
      id: w.id,
      key: w.key,
      status: rows.find((r) => r.key === w.key)!.status,
    })),
  });
});

generationRoutes.post('/apps/:appId/generation/claim', async (c) => {
  const appId = c.req.param('appId');
  const who = await contributor(c, appId);
  const b = await nativeBody(c, 8192);
  const models = b.models;
  if (
    (b.setId !== undefined && typeof b.setId !== 'string') ||
    !Array.isArray(models) ||
    !models.length ||
    models.length > GENERATION_LIMITS.models ||
    models.some((m) => typeof m?.model !== 'string' || typeof m?.modelVersion !== 'string')
  ) {
    throw new HttpError(400, 'invalid claim');
  }
  const now = Date.now();
  const token = `glt_${nativeRandom()}`;
  // One open lease per user: a new claim releases the previous one, whose job
  // that user can never be given again.
  await c.env.DB.prepare(
    "UPDATE generation_leases SET state = 'released' WHERE user_id = ? AND state = 'open'",
  )
    .bind(who.id)
    .run();
  // One statement, so concurrent claims cannot over-assign a job's replicas.
  // Sets that require attestation are not claimable until it is verified (#732).
  const claimed = await c.env.DB.prepare(
    `INSERT INTO generation_leases (job_id, user_id, app_id, token_hash, state, created_at, expires_at)
     SELECT j.id, ?1, ?2, ?3, 'open', ?4, ?5
     FROM generation_jobs j JOIN generation_sets s ON s.id = j.set_id
     WHERE j.app_id = ?2 AND j.status = 'open' AND (?6 IS NULL OR j.set_id = ?6)
       AND s.require_attestation = 0
       AND EXISTS (SELECT 1 FROM json_each(?7) m WHERE json_extract(m.value, '$.model') = s.model
         AND json_extract(m.value, '$.modelVersion') = s.model_version)
       AND NOT EXISTS (SELECT 1 FROM generation_leases l WHERE l.job_id = j.id AND l.user_id = ?1)
       AND NOT EXISTS (SELECT 1 FROM generation_leases l WHERE l.user_id = ?1 AND l.state = 'open' AND l.expires_at > ?4)
       AND (SELECT COUNT(*) FROM generation_leases l WHERE l.job_id = j.id AND l.state = 'open' AND l.expires_at > ?4)
         + (SELECT COUNT(*) FROM generation_submissions x WHERE x.job_id = j.id AND x.status = 'pending') < s.replicas
     ORDER BY j.created_at, j.rowid LIMIT 1
     RETURNING job_id`,
  )
    .bind(
      who.id,
      appId,
      await nativeHash(token),
      now,
      now + GENERATION_LIMITS.leaseMs,
      b.setId ?? null,
      JSON.stringify(models),
    )
    .first<{ job_id: string }>();
  if (!claimed) return c.body(null, 204);
  const job = await c.env.DB.prepare(
    `SELECT j.set_id, j.key, j.input, s.model, s.model_version, s.params, s.formats, s.max_bytes
     FROM generation_jobs j JOIN generation_sets s ON s.id = j.set_id WHERE j.id = ?`,
  )
    .bind(claimed.job_id)
    .first<JobJoin>();
  return c.json({
    job: {
      id: claimed.job_id,
      setId: job!.set_id,
      key: job!.key,
      input: JSON.parse(job!.input),
      model: job!.model,
      modelVersion: job!.model_version,
      params: JSON.parse(job!.params),
      formats: JSON.parse(job!.formats),
      maxBytes: job!.max_bytes,
      leaseToken: token,
      leaseExpiresAt: now + GENERATION_LIMITS.leaseMs,
    },
  });
});

/** The request body, or null once it exceeds `max` bytes (Content-Length is not trusted). */
async function boundedBody(c: Ctx, max: number): Promise<Uint8Array | null> {
  if (Number(c.req.header('Content-Length') ?? 0) > max) return null;
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader?.read();
    if (!chunk || chunk.done) break;
    size += chunk.value.length;
    if (size > max) {
      await reader!.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

generationRoutes.put('/apps/:appId/generation/jobs/:jobId/result', async (c) => {
  const appId = c.req.param('appId');
  const jobId = c.req.param('jobId');
  const who = await contributor(c, appId);
  const leaseToken = c.req.header('X-Lease-Token') ?? '';
  const tokenHash = await nativeHash(leaseToken);
  const now = Date.now();
  const set = /^glt_[a-f0-9]{64}$/.test(leaseToken)
    ? await c.env.DB.prepare(
        `SELECT s.* FROM generation_leases l JOIN generation_jobs j ON j.id = l.job_id
         JOIN generation_sets s ON s.id = j.set_id
         WHERE l.job_id = ? AND l.user_id = ? AND l.app_id = ? AND l.token_hash = ? AND l.state = 'open' AND l.expires_at > ?`,
      )
        .bind(jobId, who.id, appId, tokenHash, now)
        .first<SetRow>()
    : null;
  if (!set) throw new HttpError(403, 'no valid lease for this job');
  const body = await boundedBody(c, set.max_bytes + GENERATION_LIMITS.metaBytes + 16_384);
  if (!body) throw new HttpError(413, `the result exceeds ${set.max_bytes} bytes`);
  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { 'Content-Type': c.req.header('Content-Type') ?? '' },
    }).formData();
  } catch {
    throw new HttpError(400, 'expected multipart/form-data');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'file required');
  const formats = JSON.parse(set.formats) as string[];
  const type = file.type.split(';')[0]!.trim();
  if (!formats.includes(type)) throw new HttpError(415, `this set accepts ${formats.join(', ')}`);
  if (!file.size) throw new HttpError(400, 'file is empty');
  if (file.size > set.max_bytes) throw new HttpError(413, `file exceeds ${set.max_bytes} bytes`);
  const metaPart = form.get('meta');
  const meta =
    metaPart === null ? null : typeof metaPart === 'string' ? metaPart : await metaPart.text();
  if (meta !== null) {
    if (new TextEncoder().encode(meta).length > GENERATION_LIMITS.metaBytes)
      throw new HttpError(413, `meta exceeds ${GENERATION_LIMITS.metaBytes} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(meta);
    } catch {
      throw new HttpError(400, 'meta must be JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new HttpError(400, 'meta must be a JSON object');
  }
  const usage = d1UsageStore(c.env.DB);
  if (
    !(await usage.bumpIfBelow!(`genuser:${who.id}`, dayKey(now), 1, GENERATION_LIMITS.userDaily)) ||
    !(await usage.bumpIfBelow!(`genapp:${appId}`, dayKey(now), 1, GENERATION_LIMITS.appDaily))
  ) {
    throw new HttpError(429, 'daily contribution limit reached; try tomorrow');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = crypto.randomUUID();
  const objectKey = `q/${appId}/${jobId}/${id}`;
  const metaKey = meta === null ? null : `${objectKey}.meta`;
  await c.env.GENERATED!.put(objectKey, bytes, { httpMetadata: { contentType: type } });
  if (metaKey)
    await c.env.GENERATED!.put(metaKey, meta!, {
      httpMetadata: { contentType: 'application/json' },
    });
  // Native attestation is recorded but not yet verified (#732).
  const attestation = c.req.header('X-Attestation') ? 'unverified' : 'none';
  // Consume the lease and record the submission together: a lease uploads once.
  const [, inserted] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE generation_leases SET state = 'used', submission_id = ?
       WHERE job_id = ? AND user_id = ? AND token_hash = ? AND state = 'open' AND expires_at > ?`,
    ).bind(id, jobId, who.id, tokenHash, now),
    c.env.DB.prepare(
      `INSERT INTO generation_submissions (id, job_id, set_id, app_id, user_id, device_kind, attestation, object_key, meta_key, bytes, content_type, sha256, status, created_at)
       SELECT ?1, j.id, j.set_id, j.app_id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
         CASE j.status WHEN 'accepted' THEN 'superseded' ELSE 'pending' END, ?10
       FROM generation_jobs j
       WHERE j.id = ?11 AND EXISTS (SELECT 1 FROM generation_leases l WHERE l.job_id = j.id AND l.submission_id = ?1)`,
    ).bind(
      id,
      who.id,
      who.device,
      attestation,
      objectKey,
      metaKey,
      bytes.length,
      type,
      hex(await crypto.subtle.digest('SHA-256', bytes)),
      now,
      jobId,
    ),
  ]);
  if (!inserted!.meta.changes) {
    await c.env.GENERATED!.delete(metaKey ? [objectKey, metaKey] : [objectKey]);
    throw new HttpError(403, 'no valid lease for this job');
  }
  const row = await c.env.DB.prepare('SELECT status FROM generation_submissions WHERE id = ?')
    .bind(id)
    .first<{ status: string }>();
  return c.json({ submissionId: id, status: row!.status }, 202);
});

generationRoutes.get('/apps/:appId/generation/submissions', async (c) => {
  const appId = c.req.param('appId');
  const who = await contributor(c, appId);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.job_id, s.set_id, j.key, s.status, s.reason, s.bytes, s.content_type, s.created_at, s.decided_at
     FROM generation_submissions s JOIN generation_jobs j ON j.id = s.job_id
     WHERE s.app_id = ? AND s.user_id = ? ORDER BY s.created_at DESC LIMIT 100`,
  )
    .bind(appId, who.id)
    .all<Record<string, string | number | null>>();
  return c.json({
    submissions: results.map((s) => ({
      submissionId: s.id,
      jobId: s.job_id,
      setId: s.set_id,
      key: s.key,
      status: s.status,
      reason: s.reason,
      bytes: s.bytes,
      contentType: s.content_type,
      createdAt: s.created_at,
      decidedAt: s.decided_at,
    })),
  });
});

generationRoutes.get('/apps/:appId/generation/sets/:setId/manifest', async (c) => {
  const appId = c.req.param('appId');
  const set = await setRow(c.env.DB, appId, c.req.param('setId'));
  if (!set) return c.text('not found', 404);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM generation_artifacts WHERE set_id = ? ORDER BY key',
  )
    .bind(set.id)
    .all<ArtifactRow>();
  const base = `${new URL(c.req.url).origin}/v1/apps/${appId}/generation/artifacts`;
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    artifacts: results.map((a) => {
      // The version pins the URL to these exact bytes, so it may be cached forever.
      const v = `?v=${a.sha256.slice(0, 16)}`;
      return {
        key: a.key,
        jobId: a.job_id,
        url: `${base}/${a.job_id}${v}`,
        ...(a.meta_key ? { metaUrl: `${base}/${a.job_id}/meta${v}` } : {}),
        bytes: a.bytes,
        contentType: a.content_type,
        durationMs: a.duration_ms,
        sha256: a.sha256,
        model: a.model,
        modelVersion: a.model_version,
        acceptedAt: a.accepted_at,
      };
    }),
  });
});

async function serveArtifact(c: Ctx, meta: boolean) {
  const row = await c.env.DB.prepare(
    'SELECT * FROM generation_artifacts WHERE job_id = ? AND app_id = ?',
  )
    .bind(c.req.param('jobId'), c.req.param('appId'))
    .first<ArtifactRow>();
  const v = c.req.query('v');
  if (!row || (meta && !row.meta_key) || (v !== undefined && v !== row.sha256.slice(0, 16)))
    return c.text('not found', 404);
  const object = await c.env.GENERATED!.get(meta ? row.meta_key! : row.object_key);
  if (!object) return c.text('not found', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': meta ? 'application/json' : row.content_type,
      'Content-Length': String(object.size),
      // A withdrawn artifact must not stay cached for long, unless the URL
      // names the exact bytes (the manifest's ?v=).
      'Cache-Control':
        v === undefined ? 'public, max-age=3600' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}

generationRoutes.get('/apps/:appId/generation/artifacts/:jobId', (c) => serveArtifact(c, false));
generationRoutes.get('/apps/:appId/generation/artifacts/:jobId/meta', (c) =>
  serveArtifact(c, true),
);

/**
 * Remove artifacts (one job's, or everything a contributor made in the app)
 * and reopen their jobs. Bulk statements, so blocking a prolific contributor
 * stays within the Worker's subrequest budget.
 */
async function withdraw(
  env: Env,
  appId: string,
  column: 'job_id' | 'user_id',
  value: string,
  actor: string,
  action: string,
): Promise<number> {
  const db = env.DB;
  const where = `app_id = ?1 AND ${column} = ?2`;
  const { results } = await db
    .prepare(`SELECT object_key, meta_key FROM generation_artifacts WHERE ${where}`)
    .bind(appId, value)
    .all<{ object_key: string; meta_key: string | null }>();
  const [, , , removed] = await db.batch([
    db
      .prepare(
        `UPDATE generation_jobs SET status = 'open' WHERE id IN (SELECT job_id FROM generation_artifacts WHERE ${where})`,
      )
      .bind(appId, value),
    db
      .prepare(
        `UPDATE generation_submissions SET status = 'rejected', reason = 'withdrawn by the app owner', decided_at = ?3
         WHERE id IN (SELECT submission_id FROM generation_artifacts WHERE ${where})`,
      )
      .bind(appId, value, Date.now()),
    audit(db, appId, actor, action, value),
    db.prepare(`DELETE FROM generation_artifacts WHERE ${where}`).bind(appId, value),
  ]);
  const keys = results.flatMap((r) => (r.meta_key ? [r.object_key, r.meta_key] : [r.object_key]));
  for (let i = 0; i < keys.length; i += 1000) await env.GENERATED!.delete(keys.slice(i, i + 1000));
  return removed!.meta.changes;
}

generationRoutes.delete('/apps/:appId/generation/artifacts/:jobId', async (c) => {
  const appId = c.req.param('appId');
  const actor = await owner(c, appId);
  const jobId = c.req.param('jobId');
  const n = await withdraw(c.env, appId, 'job_id', jobId, actor, 'artifact.withdraw');
  if (!n) throw new HttpError(404, 'artifact not found');
  return c.json({ withdrawn: n });
});

generationRoutes.post('/apps/:appId/generation/contributors/:userId/block', async (c) => {
  const appId = c.req.param('appId');
  const userId = c.req.param('userId');
  const actor = await owner(c, appId);
  const db = c.env.DB;
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        'INSERT INTO generation_blocks (app_id, user_id, blocked_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .bind(appId, userId, actor, now),
    db
      .prepare(
        "UPDATE generation_leases SET state = 'released' WHERE app_id = ? AND user_id = ? AND state = 'open'",
      )
      .bind(appId, userId),
    db
      .prepare(
        `UPDATE generation_submissions SET status = 'rejected', reason = 'contributor blocked', decided_at = ?
         WHERE app_id = ? AND user_id = ? AND status = 'pending'`,
      )
      .bind(now, appId, userId),
  ]);
  const withdrawn = await withdraw(c.env, appId, 'user_id', userId, actor, 'contributor.block');
  return c.json({ blocked: true, withdrawn });
});

/**
 * Promote a verified pending submission (#729). Write-once: the artifact row is
 * inserted first and its job_id PRIMARY KEY admits one per job, so a second
 * accept is `superseded` and can never overwrite. Only then are the bytes
 * copied out of quarantine, under a key unique to this submission.
 */
export async function acceptSubmission(
  env: Env,
  submissionId: string,
  durationMs: number | null,
): Promise<'accepted' | 'superseded'> {
  const db = env.DB;
  const now = Date.now();
  const sub = await db
    .prepare(
      `SELECT x.*, j.key, s.model, s.model_version FROM generation_submissions x
       JOIN generation_jobs j ON j.id = x.job_id JOIN generation_sets s ON s.id = x.set_id
       WHERE x.id = ? AND x.status = 'pending'`,
    )
    .bind(submissionId)
    .first<SubmissionRow & { key: string; model: string; model_version: string }>();
  if (!sub) throw new Error(`submission ${submissionId} is not pending`);
  const objectKey = `a/${sub.app_id}/${sub.job_id}/${sub.id}`;
  const metaKey = sub.meta_key ? `${objectKey}.meta` : null;
  const inserted = await db
    .prepare(
      `INSERT INTO generation_artifacts (job_id, set_id, app_id, key, submission_id, user_id, device_kind, attestation,
         object_key, meta_key, bytes, content_type, duration_ms, sha256, model, model_version, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(
      sub.job_id,
      sub.set_id,
      sub.app_id,
      sub.key,
      sub.id,
      sub.user_id,
      sub.device_kind,
      sub.attestation,
      objectKey,
      metaKey,
      sub.bytes,
      sub.content_type,
      durationMs,
      sub.sha256,
      sub.model,
      sub.model_version,
      now,
    )
    .run();
  if (!inserted.meta.changes) {
    await db
      .prepare(
        "UPDATE generation_submissions SET status = 'superseded', decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .bind(now, sub.id)
      .run();
    return 'superseded';
  }
  try {
    const copies: [string, string, string][] = [[sub.object_key, objectKey, sub.content_type]];
    if (sub.meta_key && metaKey) copies.push([sub.meta_key, metaKey, 'application/json']);
    for (const [from, to, contentType] of copies) {
      const object = await env.GENERATED!.get(from);
      if (!object) throw new Error(`quarantined object ${from} is missing`);
      await env.GENERATED!.put(to, await object.arrayBuffer(), { httpMetadata: { contentType } });
    }
  } catch (error) {
    // Not public yet: undo, so a retry (or another submission) can accept.
    await db
      .prepare('DELETE FROM generation_artifacts WHERE job_id = ? AND submission_id = ?')
      .bind(sub.job_id, sub.id)
      .run();
    throw error;
  }
  await db.batch([
    db
      .prepare("UPDATE generation_submissions SET status = 'accepted', decided_at = ? WHERE id = ?")
      .bind(now, sub.id),
    db.prepare("UPDATE generation_jobs SET status = 'accepted' WHERE id = ?").bind(sub.job_id),
    db
      .prepare(
        "UPDATE generation_submissions SET status = 'superseded', decided_at = ? WHERE job_id = ? AND status = 'pending'",
      )
      .bind(now, sub.job_id),
  ]);
  await env.GENERATED!.delete(sub.meta_key ? [sub.object_key, sub.meta_key] : [sub.object_key]);
  return 'accepted';
}

/**
 * Bounded, retryable cleanup. Artifacts of apps no longer in the store are
 * deleted object first (they are permanent); then those apps' sets (cascading
 * jobs, leases, submissions), blocks and audit rows go. Quarantine objects
 * expire by R2 lifecycle, so pending submissions older than that are rejected.
 */
export async function pruneGenerated(env: Env, now = Date.now(), limit = 100): Promise<number> {
  if (!env.GENERATED) return 0;
  const db = env.DB;
  const gone =
    "NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = g.app_id AND (a.store IS NULL OR a.store = 'apps'))";
  const { results } = await db
    .prepare(
      `SELECT job_id, object_key, meta_key FROM generation_artifacts g WHERE ${gone} LIMIT ?`,
    )
    .bind(limit)
    .all<{ job_id: string; object_key: string; meta_key: string | null }>();
  if (results.length) {
    await env.GENERATED.delete(
      results.flatMap((r) => (r.meta_key ? [r.object_key, r.meta_key] : [r.object_key])),
    );
    await db
      .prepare('DELETE FROM generation_artifacts WHERE job_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(results.map((r) => r.job_id)))
      .run();
  }
  await db.batch([
    db.prepare(
      `DELETE FROM generation_sets WHERE id IN (SELECT g.id FROM generation_sets g WHERE ${gone}
         AND NOT EXISTS (SELECT 1 FROM generation_artifacts x WHERE x.set_id = g.id))`,
    ),
    db.prepare(
      `DELETE FROM generation_blocks WHERE rowid IN (SELECT g.rowid FROM generation_blocks g WHERE ${gone})`,
    ),
    db.prepare(
      `DELETE FROM generation_audit WHERE id IN (SELECT g.id FROM generation_audit g WHERE ${gone})`,
    ),
    db
      .prepare(
        `UPDATE generation_submissions SET status = 'rejected', reason = 'expired before verification', decided_at = ?
         WHERE status = 'pending' AND created_at < ?`,
      )
      .bind(now, now - GENERATION_LIMITS.pendingMs),
  ]);
  return results.length;
}
