/**
 * Community generation (#727, #728). The app owner publishes sets (model,
 * version, params) and jobs (key + input); signed-in users' devices claim a
 * job under a lease, generate locally and upload into private quarantine. Only
 * the verifier promotes a submission, through acceptSubmission(), into a
 * write-once public artifact. See docs/community-generation.md.
 */
import { type Context, Hono } from 'hono';
import { APP_ID_RE } from '../lib/apps.js';
import {
  FAS_APP_ROWS,
  HttpError,
  requireAppOwner,
  requireAppUser,
  requireConsoleUser,
} from '../lib/auth.js';
import { cpsBand, type Verdict, verdict } from '../lib/generation-verify.js';
import { verifyGithubOidc } from '../lib/github-oidc.js';
import { nativeBody, nativeDevice, nativeHash, nativeRandom } from '../lib/native-companion.js';
import { queryLimit } from '../lib/paging.js';
import { d1UsageStore, dayKey } from '../lib/proxy-rate-limit.js';
import type { Env } from '../types.js';
import { APP_ORG_ID, DEPLOY_AUDIENCE } from './deploy.js';

type Ctx = Context<{ Bindings: Env }>;

/** The app's daily cap's `429` (no `Retry-After`: runners treat it as final until the next UTC day). */
const DAILY_LIMIT = "this app's daily generation budget is used up; try tomorrow";

export const GENERATION_LIMITS = {
  leaseMs: 15 * 60_000,
  /** Extensions (#783) never take a lease past this long after its claim. */
  leaseMaxMs: 2 * 60 * 60_000,
  /** Open leases one user holds at once, across their runners (devices, browsers) (#825). */
  userLeases: 4,
  appDaily: 5_000,
  jobsPerRequest: 500,
  /** A whole chapter. */
  textChars: 100_000,
  maxBytes: 25_000_000,
  metaBytes: 64 * 1024,
  models: 20,
  /** Quarantine objects expire after 7 days (R2 lifecycle); stop waiting a day earlier. */
  pendingMs: 6 * 24 * 60 * 60_000,
  /** Verifications (each up to a few Whisper calls) per app per UTC day. */
  /** A verifier that has not finished in this long is presumed dead. */
  verifyLockMs: 10 * 60_000,
  /** Replicas agree when their durations differ by at most this fraction. */
  replicaDurationSlack: 0.15,
  /** Attempt records (#813, #827): per request, per user per UTC day, and how long they are kept. */
  eventsPerRequest: 50,
  eventsDaily: 1_000,
  eventsKeepMs: 14 * 24 * 60 * 60_000,
};

/** How a job attempt ended on the device (#813), the same on every runner; `submitted`: it uploaded. */
export const GENERATION_END_REASONS = [
  'submitted',
  'user_stop',
  'unplugged',
  'thermal',
  'background_expired',
  'network',
  'lease_403',
  'lease_cap',
  'model_missing',
  'model_error',
  'encode_error',
  'too_large',
  'unsupported',
  'server_4xx',
  'server_5xx',
  'other',
] as const;
const RUNNERS = ['android', 'ios', 'browser', 'desktop'];
/**
 * What a device may report about one attempt (#827): numbers and context, no
 * text or audio. Stage wall times, process CPU time and peak memory where the
 * platform exposes them, battery (0-100) and thermal state at start and end.
 */
const RECORD_FIELDS = {
  error: 'string',
  appVersion: 'string',
  os: 'string',
  device: 'string',
  network: 'string',
  thermalStart: 'string',
  thermalEnd: 'string',
  background: 'boolean',
  chargingStart: 'boolean',
  chargingEnd: 'boolean',
  batteryStart: 'number',
  batteryEnd: 'number',
  startedAt: 'number',
  wallMs: 'number',
  loadMs: 'number',
  synthMs: 'number',
  encodeMs: 'number',
  uploadMs: 'number',
  cpuMs: 'number',
  peakMemMb: 'number',
  rtf: 'number',
  bytes: 'number',
  durationMs: 'number',
} as const;
const FORMATS = ['audio/mp4', 'audio/ogg', 'audio/wav'];
const KEY_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const NAME_RE = /^[A-Za-z0-9._:/@+-]{1,120}$/;
/** A BCP 47 language tag such as `en`, `zh`, `zh-Hans` or `pt-BR` (#810). */
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,4}$/;
const WITHDRAWN = 'withdrawn by the app owner';

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
  /** Verification thresholds (#729): characters per second band, word error rate. */
  min_cps: number;
  max_cps: number;
  /** BCP 47 tag of the input text (#810); null: unspecified. */
  language: string | null;
}
type JobJoin = Pick<
  SetRow,
  'model' | 'model_version' | 'params' | 'formats' | 'max_bytes' | 'language'
> & {
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
    minCharsPerSecond: row.min_cps,
    maxCharsPerSecond: row.max_cps,
    language: row.language,
    createdAt: row.created_at,
  };
}

const setRow = (db: D1Database, appId: string, setId: string) =>
  db
    .prepare('SELECT * FROM generation_sets WHERE id = ? AND app_id = ?')
    .bind(setId, appId)
    .first<SetRow>();

/**
 * Jobs (`j`, of set `s`) the user may be given now: open, in a set that needs
 * no attestation (#732), in an app that has not blocked the user, never leased
 * to the user before, with a free replica slot. Claim and discovery (#794)
 * share it; `user` and `now` name the SQL parameters.
 */
const claimable = (user: string, now: string) => `j.status = 'open' AND s.require_attestation = 0
  AND NOT EXISTS (SELECT 1 FROM generation_blocks b WHERE b.app_id = j.app_id AND b.user_id = ${user})
  AND NOT EXISTS (SELECT 1 FROM generation_leases l WHERE l.job_id = j.id AND l.user_id = ${user})
  AND (SELECT COUNT(*) FROM generation_leases l WHERE l.job_id = j.id AND l.state = 'open' AND l.expires_at > ${now})
    + (SELECT COUNT(*) FROM generation_submissions x WHERE x.job_id = j.id AND x.status = 'pending') < s.replicas`;

/** Public URL of a job's artifact (or its `/meta`). `?v=` pins it to these exact bytes. */
const artifactUrl = (c: Ctx, a: Pick<ArtifactRow, 'app_id' | 'job_id' | 'sha256'>, path = '') =>
  `${new URL(c.req.url).origin}/v1/apps/${a.app_id}/generation/artifacts/${a.job_id}${path}?v=${a.sha256.slice(0, 16)}`;

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

/**
 * An app-audience session, or a native companion device (`ndev_`). Without an
 * app (cross-app discovery) the session must be first-party (#495). `runner`
 * is the device that holds a lease (#825): the native device, or a session's
 * `X-Runner-Id` (one default runner, '', when it sends none).
 */
async function contributor(c: Ctx, appId?: string) {
  let id: string, device: 'web' | 'native', runner: string;
  if (c.req.header('Authorization')?.startsWith('Bearer ndev_')) {
    const d = await nativeDevice(c);
    const user = await c.env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(d.user_id).first();
    if (!user) throw new HttpError(401, 'Account no longer exists.');
    id = d.user_id;
    device = 'native';
    runner = `ndev:${d.id}`;
  } else {
    id = (appId ? await requireAppUser(c, appId) : await requireConsoleUser(c)).id;
    device = 'web';
    const header = c.req.header('X-Runner-Id');
    if (header !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(header))
      throw new HttpError(400, 'X-Runner-Id must be 8-64 characters of A-Z, a-z, 0-9, _ or -');
    runner = header === undefined ? '' : `web:${header}`;
  }
  if (!appId) return { id, device, runner };
  const blocked = await c.env.DB.prepare(
    'SELECT 1 FROM generation_blocks WHERE app_id = ? AND user_id = ?',
  )
    .bind(appId, id)
    .first();
  if (blocked) throw new HttpError(403, 'blocked from contributing to this app');
  return { id, device, runner };
}

generationRoutes.post('/apps/:appId/generation/sets', async (c) => {
  const appId = c.req.param('appId');
  const actor = await owner(c, appId);
  const b = await nativeBody(c, 8192);
  const formats = b.formats;
  const params = JSON.stringify(b.params ?? {});
  const language = b.language ?? null;
  const validLanguage =
    language === null || (typeof language === 'string' && LANGUAGE_RE.test(language));
  const [minDefault, maxDefault] = cpsBand(validLanguage ? (language as string | null) : null);
  const minCps = b.minCharsPerSecond ?? minDefault,
    maxCps = b.maxCharsPerSecond ?? maxDefault;
  if (
    !validLanguage ||
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
    (b.requireAttestation !== undefined && typeof b.requireAttestation !== 'boolean') ||
    typeof minCps !== 'number' ||
    typeof maxCps !== 'number' ||
    !(minCps > 0 && minCps < maxCps && maxCps <= 100)
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
    min_cps: minCps,
    max_cps: maxCps,
    language: language as string | null,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO generation_sets (id, app_id, kind, model, model_version, params, formats, max_bytes, replicas, require_attestation, created_by, created_at, min_cps, max_cps, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const { jobs } = await nativeBody(c, 8_000_000);
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
    // D1 caps a bound value at 2 MB: insert in chunks, in one transaction.
    const chunks: (typeof wanted)[] = [[]];
    let size = 0;
    for (const w of wanted) {
      size += w.input.length + 300;
      if (size > 900_000 && chunks.at(-1)!.length) {
        chunks.push([]);
        size = w.input.length + 300;
      }
      chunks.at(-1)!.push(w);
    }
    const now = Date.now();
    await c.env.DB.batch(
      chunks.map((chunk) =>
        c.env.DB.prepare(
          `INSERT INTO generation_jobs (id, set_id, app_id, key, input, status, created_at)
           SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.key'), json_extract(value, '$.input'), 'open', ?
           FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`,
        ).bind(set.id, appId, now, JSON.stringify(chunk)),
      ),
    );
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

/**
 * The app's sets, newest first, with progress (#794): jobs by status, live
 * leases, and submissions pending, rejected and withdrawn by the owner.
 */
generationRoutes.get('/apps/:appId/generation/sets', async (c) => {
  const appId = c.req.param('appId');
  await owner(c, appId);
  const jobs = (where: string) =>
    `(SELECT COUNT(*) FROM generation_jobs j WHERE j.set_id = s.id${where})`;
  const submissions = (where: string) =>
    `(SELECT COUNT(*) FROM generation_jobs j JOIN generation_submissions x ON x.job_id = j.id WHERE j.set_id = s.id AND ${where})`;
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, ${jobs('')} AS n_jobs, ${jobs(" AND j.status = 'open'")} AS n_open,
       ${jobs(" AND j.status = 'accepted'")} AS n_accepted,
       (SELECT COUNT(*) FROM generation_jobs j JOIN generation_leases l ON l.job_id = j.id
         WHERE j.set_id = s.id AND l.state = 'open' AND l.expires_at > ?2) AS n_leased,
       ${submissions("x.status = 'pending'")} AS n_pending,
       ${submissions("x.status = 'rejected' AND x.reason IS NOT ?3")} AS n_rejected,
       ${submissions("x.status = 'rejected' AND x.reason = ?3")} AS n_withdrawn
     FROM generation_sets s WHERE s.app_id = ?1 ORDER BY s.created_at DESC, s.id`,
  )
    .bind(appId, Date.now(), WITHDRAWN)
    .all<SetRow & Record<`n_${string}`, number>>();
  return c.json({
    sets: results.map((r) => ({
      ...setInfo(r),
      counts: {
        jobs: r.n_jobs,
        open: r.n_open,
        leased: r.n_leased,
        pending: r.n_pending,
        accepted: r.n_accepted,
        rejected: r.n_rejected,
        withdrawn: r.n_withdrawn,
      },
    })),
  });
});

const PREVIEW_CHARS = 200;
/** Who contributed: user id (for blocking) and GitHub login; null once the account is deleted. */
const contributorInfo = (id: string | null, login: string | null) => (id ? { id, login } : null);

/**
 * The owner's view of a set's jobs by key after `cursor`, at most `limit` (or
 * only `jobId`): each with its accepted artifact and its 5 latest submissions
 * (#794). `more` tells whether there are jobs after the page.
 */
async function ownerJobs(
  c: Ctx,
  appId: string,
  setId: string,
  q: { status: string | null; cursor: string; limit: number; jobId?: string },
) {
  const { results: rows } = await c.env.DB.prepare(
    `SELECT j.id, j.key, j.status, j.created_at,
       substr(json_extract(j.input, '$.text'), 1, ?5) AS preview, length(json_extract(j.input, '$.text')) AS chars,
       a.sha256, a.bytes, a.duration_ms, a.user_id, u.github_login, a.accepted_at
     FROM generation_jobs j LEFT JOIN generation_artifacts a ON a.job_id = j.id
     LEFT JOIN users u ON u.id = a.user_id
     WHERE j.set_id = ?1 AND (?2 IS NULL OR j.status = ?2) AND j.key > ?3 AND (?6 IS NULL OR j.id = ?6)
     ORDER BY j.key LIMIT ?4`,
  )
    .bind(setId, q.status, q.cursor, q.limit + 1, PREVIEW_CHARS, q.jobId ?? null)
    .all<{
      id: string;
      key: string;
      status: string;
      created_at: number;
      preview: string;
      chars: number;
      sha256: string | null;
      bytes: number;
      duration_ms: number | null;
      user_id: string | null;
      github_login: string | null;
      accepted_at: number;
    }>();
  const page = rows.slice(0, q.limit);
  const { results: subs } = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT x.id, x.job_id, x.user_id, u.github_login, x.device_kind, x.attestation, x.status, x.reason,
         x.wer, x.duration_ms, x.created_at, x.decided_at,
         ROW_NUMBER() OVER (PARTITION BY x.job_id ORDER BY x.created_at DESC, x.id) AS n
       FROM generation_submissions x LEFT JOIN users u ON u.id = x.user_id
       WHERE x.job_id IN (SELECT value FROM json_each(?))
     ) WHERE n <= 5 ORDER BY created_at DESC, id`,
  )
    .bind(JSON.stringify(page.map((j) => j.id)))
    .all<{
      id: string;
      job_id: string;
      user_id: string;
      github_login: string | null;
      device_kind: string;
      attestation: string;
      status: string;
      reason: string | null;
      wer: number | null;
      duration_ms: number | null;
      created_at: number;
      decided_at: number | null;
    }>();
  // Attempt records (#827), linked to a submission through the lease.
  const { results: events } = await c.env.DB.prepare(
    `SELECT e.job_id, e.user_id, u.github_login, e.runner, e.reason, e.record, e.created_at, l.submission_id
     FROM generation_events e LEFT JOIN generation_leases l ON l.job_id = e.job_id AND l.user_id = e.user_id
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.job_id IN (SELECT value FROM json_each(?)) ORDER BY e.created_at DESC`,
  )
    .bind(JSON.stringify(page.map((j) => j.id)))
    .all<{
      job_id: string;
      user_id: string;
      github_login: string | null;
      runner: string;
      reason: string;
      record: string;
      created_at: number;
      submission_id: string | null;
    }>();
  const record = (e: (typeof events)[number]) => ({
    runner: e.runner,
    reason: e.reason,
    createdAt: e.created_at,
    ...(JSON.parse(e.record) as Record<string, unknown>),
  });
  const jobs = page.map((j) => ({
    id: j.id,
    key: j.key,
    status: j.status,
    inputPreview: j.preview,
    inputChars: j.chars,
    createdAt: j.created_at,
    artifact: j.sha256
      ? {
          url: artifactUrl(c, { app_id: appId, job_id: j.id, sha256: j.sha256 }),
          durationMs: j.duration_ms,
          bytes: j.bytes,
          contributor: contributorInfo(j.user_id, j.github_login),
          acceptedAt: j.accepted_at,
        }
      : null,
    submissions: subs
      .filter((x) => x.job_id === j.id)
      .map((x) => ({
        id: x.id,
        contributor: contributorInfo(x.user_id, x.github_login),
        deviceKind: x.device_kind,
        attestation: x.attestation,
        status: x.status,
        reason: x.reason,
        wer: x.wer,
        durationMs: x.duration_ms,
        createdAt: x.created_at,
        decidedAt: x.decided_at,
        record: ((e) => (e ? record(e) : null))(events.find((e) => e.submission_id === x.id)),
      })),
    // Attempts that ended without an upload, the 5 latest.
    attempts: events
      .filter((e) => e.job_id === j.id && !e.submission_id)
      .slice(0, 5)
      .map((e) => ({ contributor: contributorInfo(e.user_id, e.github_login), ...record(e) })),
  }));
  return { jobs, more: rows.length > q.limit };
}

/**
 * A set's jobs by key, paged with `cursor` (the last key of the previous page)
 * and `limit` (50, at most 200); `status` filters by `open` or `accepted`.
 */
generationRoutes.get('/apps/:appId/generation/sets/:setId/jobs', async (c) => {
  const appId = c.req.param('appId');
  await owner(c, appId);
  const set = await setRow(c.env.DB, appId, c.req.param('setId'));
  if (!set) throw new HttpError(404, 'set not found');
  const status = c.req.query('status');
  if (status !== undefined && status !== 'open' && status !== 'accepted')
    throw new HttpError(400, 'status must be open or accepted');
  const limit = queryLimit(c.req.query('limit'), 50, 200);
  const { jobs, more } = await ownerJobs(c, appId, set.id, {
    status: status ?? null,
    cursor: c.req.query('cursor') ?? '',
    limit,
  });
  return c.json({ jobs, nextCursor: more ? jobs.at(-1)!.key : null });
});

/** One job as the list shows it, plus its whole input (the list has a 200-character preview) (#795). */
generationRoutes.get('/apps/:appId/generation/sets/:setId/jobs/:jobId', async (c) => {
  const appId = c.req.param('appId');
  await owner(c, appId);
  const set = await setRow(c.env.DB, appId, c.req.param('setId'));
  if (!set) throw new HttpError(404, 'set not found');
  const jobId = c.req.param('jobId');
  const q = { status: null, cursor: '', limit: 1, jobId };
  const [job] = (await ownerJobs(c, appId, set.id, q)).jobs;
  if (!job) throw new HttpError(404, 'job not found');
  const row = await c.env.DB.prepare('SELECT input FROM generation_jobs WHERE id = ?')
    .bind(jobId)
    .first<{ input: string }>();
  return c.json({ job: { ...job, input: JSON.parse(row!.input) as { text: string } } });
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
  // A claim the upload would refuse (the app's daily cap) leases nothing (#828): a runner that claimed
  // anyway generated the job, was refused, and that user could never take the job again. There is no
  // per-user cap (#830): contributors set their own limits on the device.
  const usage = d1UsageStore(c.env.DB);
  if ((await usage.read(`genapp:${appId}`, dayKey(now))) >= GENERATION_LIMITS.appDaily) {
    throw new HttpError(429, DAILY_LIMIT);
  }
  const token = `glt_${nativeRandom()}`;
  // One open lease per runner (#825): a new claim releases this runner's
  // previous one, whose job that user can never be given again. The user's
  // other devices keep theirs, up to `userLeases` open leases in all.
  await c.env.DB.prepare(
    "UPDATE generation_leases SET state = 'released' WHERE user_id = ? AND runner = ? AND state = 'open'",
  )
    .bind(who.id, who.runner)
    .run();
  const held = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM generation_leases WHERE user_id = ? AND state = 'open' AND expires_at > ?",
  )
    .bind(who.id, now)
    .first<{ n: number }>();
  if (held!.n >= GENERATION_LIMITS.userLeases)
    throw new HttpError(
      429,
      `at most ${GENERATION_LIMITS.userLeases} open leases per user; finish or let one expire on another device first`,
    );
  // One statement, so concurrent claims cannot over-assign a job's replicas
  // or exceed the user's lease cap.
  // Sets that require attestation are not claimable until it is verified (#732).
  const claimed = await c.env.DB.prepare(
    `INSERT INTO generation_leases (job_id, user_id, app_id, token_hash, state, created_at, expires_at, runner)
     SELECT j.id, ?1, ?2, ?3, 'open', ?4, ?5, ?8
     FROM generation_jobs j JOIN generation_sets s ON s.id = j.set_id
     WHERE j.app_id = ?2 AND (?6 IS NULL OR j.set_id = ?6) AND ${claimable('?1', '?4')}
       AND EXISTS (SELECT 1 FROM json_each(?7) m WHERE json_extract(m.value, '$.model') = s.model
         AND json_extract(m.value, '$.modelVersion') = s.model_version)
       AND NOT EXISTS (SELECT 1 FROM generation_leases l WHERE l.user_id = ?1 AND l.runner = ?8 AND l.state = 'open' AND l.expires_at > ?4)
       AND (SELECT COUNT(*) FROM generation_leases l WHERE l.user_id = ?1 AND l.state = 'open' AND l.expires_at > ?4) < ?9
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
      who.runner,
      GENERATION_LIMITS.userLeases,
    )
    .first<{ job_id: string }>();
  if (!claimed) return c.body(null, 204);
  const job = await c.env.DB.prepare(
    `SELECT j.set_id, j.key, j.input, s.model, s.model_version, s.params, s.formats, s.max_bytes, s.language
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
      language: job!.language,
      leaseToken: token,
      leaseExpiresAt: now + GENERATION_LIMITS.leaseMs,
    },
  });
});

/**
 * Extend an open lease while the device is still generating (#783): to 15
 * minutes from now, never past 2 hours after the claim. The token stays the
 * same. `409` once the cap is reached; `403` for an invalid, used, released or
 * expired lease.
 */
generationRoutes.post('/apps/:appId/generation/jobs/:jobId/lease', async (c) => {
  const appId = c.req.param('appId');
  const jobId = c.req.param('jobId');
  const who = await contributor(c, appId);
  const leaseToken = c.req.header('X-Lease-Token') ?? '';
  if (!/^glt_[a-f0-9]{64}$/.test(leaseToken))
    throw new HttpError(403, 'no valid lease for this job');
  const now = Date.now();
  const lease = `job_id = ?1 AND user_id = ?2 AND app_id = ?3 AND token_hash = ?4 AND state = 'open' AND expires_at > ?5`;
  const binds = [jobId, who.id, appId, await nativeHash(leaseToken), now] as const;
  const extended = await c.env.DB.prepare(
    `UPDATE generation_leases SET expires_at = MAX(expires_at, MIN(?5 + ?6, created_at + ?7))
     WHERE ${lease} AND expires_at < created_at + ?7 RETURNING expires_at`,
  )
    .bind(...binds, GENERATION_LIMITS.leaseMs, GENERATION_LIMITS.leaseMaxMs)
    .first<{ expires_at: number }>();
  if (extended) return c.json({ leaseExpiresAt: extended.expires_at });
  const capped = await c.env.DB.prepare(`SELECT expires_at FROM generation_leases WHERE ${lease}`)
    .bind(...binds)
    .first<{ expires_at: number }>();
  if (!capped) throw new HttpError(403, 'no valid lease for this job');
  return c.json(
    { error: 'the lease cannot be extended further', leaseExpiresAt: capped.expires_at },
    409,
  );
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
  if (!(await usage.bumpIfBelow!(`genapp:${appId}`, dayKey(now), 1, GENERATION_LIMITS.appDaily))) {
    throw new HttpError(429, DAILY_LIMIT);
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
  // Verify right away; the */15 cron retries anything this does not finish.
  if (row!.status === 'pending') c.executionCtx.waitUntil(verifySubmission(c.env, id));
  return c.json({ submissionId: id, status: row!.status }, 202);
});

/**
 * The caller's own 100 newest submissions to the app (#824): with what
 * verification measured (`wer`, `durationMs`), the job's input text (the
 * caller received it when claiming), and the job's accepted artifact, which may
 * come from another user's submission (then `status` is not `accepted`).
 */
generationRoutes.get('/apps/:appId/generation/submissions', async (c) => {
  const appId = c.req.param('appId');
  const who = await contributor(c, appId);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.job_id, s.set_id, j.key, s.status, s.reason, s.bytes, s.content_type, s.created_at, s.decided_at,
       s.wer, s.duration_ms, json_extract(j.input, '$.text') AS text, a.sha256 AS a_sha256, a.meta_key AS a_meta_key
     FROM generation_submissions s JOIN generation_jobs j ON j.id = s.job_id
     LEFT JOIN generation_artifacts a ON a.job_id = s.job_id
     WHERE s.app_id = ? AND s.user_id = ? ORDER BY s.created_at DESC LIMIT 100`,
  )
    .bind(appId, who.id)
    .all<Record<string, string | number | null>>();
  return c.json({
    submissions: results.map((s) => {
      const a = s.a_sha256
        ? { app_id: appId, job_id: s.job_id as string, sha256: s.a_sha256 as string }
        : null;
      return {
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
        wer: s.wer,
        durationMs: s.duration_ms,
        input: { text: s.text },
        artifact: a
          ? { url: artifactUrl(c, a), metaUrl: s.a_meta_key ? artifactUrl(c, a, '/meta') : null }
          : null,
      };
    }),
  });
});

/** A device's record of one attempt, validated: only RECORD_FIELDS, strings of at most 300 characters. */
function attemptRecord(e: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(e)) {
    if (name === 'jobId' || name === 'runner' || name === 'reason' || value === null) continue;
    const type = RECORD_FIELDS[name as keyof typeof RECORD_FIELDS];
    const ok =
      type === 'string'
        ? typeof value === 'string' && value.length <= 300
        : type === 'number'
          ? typeof value === 'number' && Number.isFinite(value) && value >= 0
          : type === 'boolean' && typeof value === 'boolean';
    if (!ok) throw new HttpError(400, `invalid event field ${name}`);
    record[name] = value;
  }
  return record;
}

/**
 * Attempt records (#813, #827): what the device measured while it ran a job it
 * leased and how the attempt ended. One per lease, a resend replaces it; events
 * for jobs the caller never leased are ignored. Owners see them in `listJobs`.
 */
generationRoutes.post('/apps/:appId/generation/events', async (c) => {
  const appId = c.req.param('appId');
  const who = await contributor(c, appId);
  const { events } = await nativeBody(c, 64 * 1024);
  if (
    !Array.isArray(events) ||
    !events.length ||
    events.length > GENERATION_LIMITS.eventsPerRequest
  )
    throw new HttpError(400, `send 1 to ${GENERATION_LIMITS.eventsPerRequest} events`);
  const rows = events.map((e) => {
    if (
      !e ||
      typeof e !== 'object' ||
      typeof e.jobId !== 'string' ||
      !RUNNERS.includes(e.runner) ||
      !GENERATION_END_REASONS.includes(e.reason)
    )
      throw new HttpError(400, 'an event needs jobId, runner and reason');
    return {
      jobId: e.jobId as string,
      runner: e.runner as string,
      reason: e.reason as string,
      record: attemptRecord(e),
    };
  });
  const now = Date.now();
  const allowed = await d1UsageStore(c.env.DB).bumpIfBelow!(
    `genevents:${who.id}`,
    dayKey(now),
    rows.length,
    GENERATION_LIMITS.eventsDaily,
  );
  if (!allowed) throw new HttpError(429, 'daily event limit reached; try tomorrow');
  const results = await c.env.DB.batch(
    rows.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO generation_events (job_id, user_id, app_id, runner, reason, record, created_at)
         SELECT l.job_id, l.user_id, l.app_id, ?4, ?5, ?6, ?7 FROM generation_leases l
         WHERE l.job_id = ?1 AND l.user_id = ?2 AND l.app_id = ?3
         ON CONFLICT (job_id, user_id) DO UPDATE SET runner = excluded.runner, reason = excluded.reason,
           record = excluded.record, created_at = excluded.created_at`,
      ).bind(r.jobId, who.id, appId, r.runner, r.reason, JSON.stringify(r.record), now),
    ),
  );
  return c.json({ recorded: results.reduce((n, r) => n + r.meta.changes, 0) });
});

/**
 * Discovery (#794): the sets with jobs the caller could claim right now, by
 * app, under the claim's own rules. A console session or a native device
 * (`ndev_`) sees every app; `?appId=` narrows to one app and then takes the
 * claim's auth exactly (that app's session too). Models are not matched here:
 * each set names its model, and the device decides what it can run.
 */
generationRoutes.get('/generation/open', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const appId = c.req.query('appId');
  if (appId !== undefined && !APP_ID_RE.test(appId)) throw new HttpError(400, 'invalid appId');
  const who = await contributor(c, appId);
  const { results } = await c.env.DB.prepare(
    `SELECT s.app_id, a.oneliner, s.id, s.kind, s.model, s.model_version, s.params, s.formats, s.max_bytes,
       s.language, COUNT(*) AS open
     FROM generation_sets s JOIN apps a ON a.id = s.app_id AND ${FAS_APP_ROWS}
     JOIN generation_jobs j ON j.set_id = s.id
     WHERE (?3 IS NULL OR s.app_id = ?3) AND ${claimable('?1', '?2')}
     GROUP BY s.id ORDER BY s.app_id, s.created_at, s.id`,
  )
    .bind(who.id, Date.now(), appId ?? null)
    .all<SetRow & { oneliner: string | null; open: number }>();
  const apps = new Map<string, { appId: string; oneliner: string | null; sets: unknown[] }>();
  for (const r of results) {
    if (!apps.has(r.app_id))
      apps.set(r.app_id, { appId: r.app_id, oneliner: r.oneliner, sets: [] });
    apps.get(r.app_id)!.sets.push({
      setId: r.id,
      kind: r.kind,
      model: r.model,
      modelVersion: r.model_version,
      params: JSON.parse(r.params),
      formats: JSON.parse(r.formats),
      maxBytes: r.max_bytes,
      language: r.language,
      open: r.open,
    });
  }
  return c.json({ apps: [...apps.values()] });
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
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    artifacts: results.map((a) => {
      // The version pins the URL to these exact bytes, so it may be cached forever.
      return {
        key: a.key,
        jobId: a.job_id,
        url: artifactUrl(c, a),
        ...(a.meta_key ? { metaUrl: artifactUrl(c, a, '/meta') } : {}),
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
        `UPDATE generation_submissions SET status = 'rejected', reason = ?4, decided_at = ?3
         WHERE id IN (SELECT submission_id FROM generation_artifacts WHERE ${where})`,
      )
      .bind(appId, value, Date.now(), WITHDRAWN),
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
    db
      .prepare('DELETE FROM generation_events WHERE created_at < ?')
      .bind(now - GENERATION_LIMITS.eventsKeepMs),
  ]);
  return results.length;
}

/**
 * Verify one pending submission (#729) and accept or reject it: container, duration and timings only,
 * with no AI compute (#831). Safe to call from several places at once: a lock on the row lets one
 * verifier work on it.
 */
export async function verifySubmission(env: Env, id: string): Promise<void> {
  if (!env.GENERATED) return;
  const db = env.DB;
  const now = Date.now();
  const sub = await db
    .prepare(
      `UPDATE generation_submissions SET verifying_at = ?1
       WHERE id = ?2 AND status = 'pending' AND passed IS NULL AND (verifying_at IS NULL OR verifying_at < ?3)
       RETURNING *`,
    )
    .bind(now, id, now - GENERATION_LIMITS.verifyLockMs)
    .first<SubmissionRow>();
  if (!sub) return;
  const unlock = () =>
    db.prepare('UPDATE generation_submissions SET verifying_at = NULL WHERE id = ?').bind(id).run();
  const set = (await db
    .prepare('SELECT * FROM generation_sets WHERE id = ?')
    .bind(sub.set_id)
    .first<SetRow>())!;
  const job = (await db
    .prepare('SELECT input FROM generation_jobs WHERE id = ?')
    .bind(sub.job_id)
    .first<{ input: string }>())!;
  let result: Verdict;
  try {
    const object = await env.GENERATED.get(sub.object_key);
    const metaObject = sub.meta_key ? await env.GENERATED.get(sub.meta_key) : null;
    result = object
      ? verdict(
          new Uint8Array(await object.arrayBuffer()),
          sub.content_type,
          metaObject ? await metaObject.text() : null,
          (JSON.parse(job.input) as { text: string }).text,
          { minCps: set.min_cps, maxCps: set.max_cps },
        )
      : { ok: false, reason: 'upload missing from quarantine' };
  } catch (error) {
    console.error('generation verify:', id, error);
    return void (await unlock());
  }
  await db
    .prepare(
      `UPDATE generation_submissions SET passed = ?, duration_ms = ?,
         status = CASE WHEN ? THEN status ELSE 'rejected' END, reason = ?, decided_at = CASE WHEN ? THEN NULL ELSE ? END
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(
      result.ok ? 1 : 0,
      result.durationMs ?? null,
      result.ok ? 1 : 0,
      result.reason ?? null,
      result.ok ? 1 : 0,
      Date.now(),
      id,
    )
    .run();
  if (!result.ok) {
    await env.GENERATED.delete(sub.meta_key ? [sub.object_key, sub.meta_key] : [sub.object_key]);
    return;
  }
  try {
    await settleJob(env, sub.job_id, set);
  } catch (error) {
    // Promotion failed (storage): verify again on a later run.
    console.error('generation accept:', id, error);
    await db
      .prepare(
        "UPDATE generation_submissions SET passed = NULL, verifying_at = NULL WHERE id = ? AND status = 'pending'",
      )
      .bind(id)
      .run();
  }
}

/**
 * With every replica in, accept the earliest passing submission if enough distinct users' passing
 * submissions agree with it on duration. Leases and submissions are one per user per job, so passing
 * submissions are from distinct users.
 */
async function settleJob(env: Env, jobId: string, set: SetRow): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, duration_ms FROM generation_submissions
     WHERE job_id = ? AND status = 'pending' AND passed = 1 ORDER BY created_at, id`,
  )
    .bind(jobId)
    .all<{ id: string; duration_ms: number }>();
  const [first, ...rest] = results;
  if (!first) return;
  const agrees = (r: (typeof results)[number]) =>
    Math.abs(r.duration_ms - first.duration_ms) <=
    GENERATION_LIMITS.replicaDurationSlack * first.duration_ms;
  const agreeing = rest.filter(agrees);
  if (1 + agreeing.length >= set.replicas) {
    await acceptSubmission(env, first.id, first.duration_ms);
    return;
  }
  // Every replica passed but they disagree: free the dissenters' slots for others.
  if (results.length >= set.replicas) {
    const now = Date.now();
    await env.DB.batch(
      rest
        .filter((r) => !agrees(r))
        .map((r) =>
          env.DB.prepare(
            `UPDATE generation_submissions SET status = 'rejected', reason = 'disagrees with other replicas', decided_at = ?
             WHERE id = ? AND status = 'pending'`,
          ).bind(now, r.id),
        ),
    );
  }
}

/** The 15-minute cron: verify a bounded batch of the oldest unverified submissions. */
export async function verifyPending(env: Env, limit = 25): Promise<number> {
  if (!env.GENERATED) return 0;
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id FROM generation_submissions
     WHERE status = 'pending' AND passed IS NULL AND (verifying_at IS NULL OR verifying_at < ?)
     ORDER BY created_at LIMIT ?`,
  )
    .bind(now - GENERATION_LIMITS.verifyLockMs, limit)
    .all<{ id: string }>();
  for (const { id } of results) await verifySubmission(env, id);
  return results.length;
}
