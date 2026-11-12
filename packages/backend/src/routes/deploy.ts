import { checkArtifactFiles } from '@freeappstore/compliance/artifact';
import { Hono } from 'hono';
import { HttpError } from '../lib/auth.js';
import { type OidcClaims, verifyGithubOidc } from '../lib/github-oidc.js';
import type { Env } from '../types.js';

/**
 * Keyless app deploys (#460, #523). An app repo's deploy job authenticates with
 * a GitHub Actions OIDC token instead of the shared org R2 key, and the build
 * output reaches R2 only through this Worker's binding, under that app's prefix.
 *
 *   POST /v1/deploys                 OIDC token + manifest {path: bytes} → {id, token}
 *   PUT  /v1/deploys/:id/files/<p>   one file, streamed to apps/<app>/.r/<id>/<p>
 *   POST /v1/deploys/:id/commit      every manifest file present → routes.release = id
 *
 * The host Worker serves `apps/<app>/.r/<release>/` once a release is set, so a
 * deploy that fails half way never serves a mix of old and new files.
 */

export const DEPLOY_AUDIENCE = 'https://api.freeappstore.online';
/** freeappstore-online's immutable org id: a renamed or recreated org cannot match. */
export const APP_ORG_ID = '281292751';
const DEPLOY_REF = 'refs/heads/main';
const DEPLOY_EVENTS = new Set(['push', 'workflow_dispatch']);
/**
 * First-party sites built in the platform monorepo rather than an app repo,
 * keyed by the workflow that deploys them. Only that workflow on main of that
 * repo may deploy that app id; the monorepo has no other deployable apps.
 */
const PLATFORM_REPO = 'freeappstore-online/platform';
const PLATFORM_SITES: Record<string, string> = {
  [`${PLATFORM_REPO}/.github/workflows/deploy-console.yml@${DEPLOY_REF}`]: 'console',
};
/**
 * The platform app deploy (#559): app repos' deploy.yml calls this reusable
 * workflow, and an app upload is accepted only when the job runs it at one of
 * these commits. Retire a version by removing its sha once no caller pins it.
 */
export const APP_DEPLOY_WORKFLOW = `${PLATFORM_REPO}/.github/workflows/app-deploy.yml`;
export const APP_DEPLOY_WORKFLOW_SHAS = new Set(['3079e4813dd86c521a3664fa93505a7bf571c64e']);
const SESSION_TTL_MS = 15 * 60 * 1000;
/** A session that keeps receiving files stays open, up to this long in all (770 MiB takes ~40 min). */
const SESSION_MAX_MS = 3 * 60 * 60 * 1000;
const DEPLOYS_PER_HOUR = 20;
const OPEN_DEPLOYS = 3;
const PRUNE_GRACE_MS = 10 * 60 * 1000;
export const MAX_FILES = 15000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
/** Uploads and copies the reuse endpoint takes per request (each is a get and a put). */
const REUSE_BATCH = 100;

export interface DeployLimits {
  files: number;
  totalBytes: number;
  fileBytes: number;
}
export const DEFAULT_LIMITS: DeployLimits = {
  files: MAX_FILES,
  totalBytes: MAX_TOTAL_BYTES,
  fileBytes: MAX_FILE_BYTES,
};

/** The app's limits: the defaults, with any column its app_deploy_limits row sets (#544). */
export async function limitsFor(db: D1Database, appId: string): Promise<DeployLimits> {
  const row = await db
    .prepare(
      'SELECT max_files, max_total_bytes, max_file_bytes FROM app_deploy_limits WHERE app_id = ?',
    )
    .bind(appId)
    .first<{
      max_files: number | null;
      max_total_bytes: number | null;
      max_file_bytes: number | null;
    }>();
  return {
    files: row?.max_files ?? DEFAULT_LIMITS.files,
    totalBytes: row?.max_total_bytes ?? DEFAULT_LIMITS.totalBytes,
    fileBytes: row?.max_file_bytes ?? DEFAULT_LIMITS.fileBytes,
  };
}
/** Code-health files live beside the app, not in a release (routes/quality.ts reads them). */
const META_PATHS = new Set(['.vcqa/report.json', '.vcqa/badge.svg']);

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  xml: 'application/xml',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  mid: 'audio/midi',
  midi: 'audio/midi',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain; charset=utf-8',
  mtl: 'text/plain; charset=utf-8',
  bin: 'application/octet-stream',
  data: 'application/octet-stream',
  atlas: 'text/plain; charset=utf-8',
  fnt: 'text/plain; charset=utf-8',
  ktx2: 'image/ktx2',
  basis: 'application/octet-stream',
  hdr: 'application/octet-stream',
  zip: 'application/zip',
  gz: 'application/gzip',
  br: 'application/octet-stream',
  onnx: 'application/octet-stream',
  tflite: 'application/octet-stream',
  pck: 'application/octet-stream',
  pak: 'application/octet-stream',
  dat: 'application/octet-stream',
  ttc: 'font/collection',
  vtt: 'text/vtt; charset=utf-8',
  srt: 'text/plain; charset=utf-8',
  jsonl: 'application/jsonl',
  ndjson: 'application/x-ndjson',
  wgsl: 'text/plain; charset=utf-8',
  glsl: 'text/plain; charset=utf-8',
  frag: 'text/plain; charset=utf-8',
  vert: 'text/plain; charset=utf-8',
  heic: 'image/heic',
  heif: 'image/heif',
  jxl: 'image/jxl',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  apng: 'image/apng',
  cur: 'image/x-icon',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  weba: 'audio/webm',
  stl: 'model/stl',
  usdz: 'model/vnd.usdz+zip',
  ply: 'application/octet-stream',
  fbx: 'application/octet-stream',
  ktx: 'image/ktx',
  dds: 'application/octet-stream',
  exr: 'image/aces',
  epub: 'application/epub+zip',
  ics: 'text/calendar; charset=utf-8',
  rss: 'application/rss+xml',
  atom: 'application/atom+xml',
  xsl: 'application/xml',
  toml: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  license: 'text/plain; charset=utf-8',
  pem: 'text/plain; charset=utf-8',
  asc: 'text/plain; charset=utf-8',
  sig: 'application/octet-stream',
  // Music notation and sound data (scoreplay, karaoke)
  abc: 'text/vnd.abc',
  ly: 'text/plain; charset=utf-8',
  musicxml: 'application/vnd.recordare.musicxml+xml',
  mxl: 'application/vnd.recordare.musicxml',
  sf2: 'application/octet-stream',
  sf3: 'application/octet-stream',
};

/** Ceilings for an override: the Worker request body limit bounds one file. */
const OVERRIDE_CEILING: DeployLimits = {
  files: 100_000,
  totalBytes: 10 * 1024 * 1024 * 1024,
  fileBytes: 95 * 1024 * 1024,
};

/**
 * Admin-set override of one app's deploy limits. A column left out or null keeps
 * its default; every given value must be a positive integer within the ceiling.
 */
export async function setDeployLimits(
  db: D1Database,
  appId: string,
  body: unknown,
  setBy: string,
): Promise<DeployLimits> {
  const b = (body ?? {}) as Record<string, unknown>;
  const pick = (key: string, max: number): number | null => {
    const v = b[key];
    if (v === undefined || v === null) return null;
    if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > max)
      throw new HttpError(400, `${key} must be an integer from 1 to ${max}`);
    return v as number;
  };
  const files = pick('max_files', OVERRIDE_CEILING.files);
  const total = pick('max_total_bytes', OVERRIDE_CEILING.totalBytes);
  const perFile = pick('max_file_bytes', OVERRIDE_CEILING.fileBytes);
  const app = await db.prepare('SELECT 1 AS ok FROM apps WHERE id = ?').bind(appId).first();
  if (!app) throw new HttpError(404, `no app ${appId}`);
  await db
    .prepare(
      `INSERT INTO app_deploy_limits (app_id, max_files, max_total_bytes, max_file_bytes, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET max_files = excluded.max_files,
         max_total_bytes = excluded.max_total_bytes, max_file_bytes = excluded.max_file_bytes,
         set_by = excluded.set_by, set_at = excluded.set_at`,
    )
    .bind(appId, files, total, perFile, setBy, Date.now())
    .run();
  return limitsFor(db, appId);
}

/**
 * A repo-relative build-output path: no absolute paths, no `.`/`..` segments,
 * no backslashes, quotes or control characters, and an allowed file extension
 * (or none). Executable/server-side types (.php, .sh, .exe, …) are refused.
 * Returns the content type to store, or null when the path is refused.
 */
export function contentTypeFor(path: string): string | null {
  if (path.length === 0 || path.length > 512) return null;
  const segments = path.split('/');
  if (
    segments.some(
      (s) => !/^[\p{L}\p{M}\p{N} _.@~+=,()!'&#%[\]$-]+$/u.test(s) || s === '.' || s === '..',
    )
  )
    return null;
  const name = segments[segments.length - 1]!;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The manifest problems, or the parsed {path: bytes} map. */
export function parseManifest(
  body: unknown,
  limits: DeployLimits = DEFAULT_LIMITS,
): { files: Record<string, number>; total: number; hashes?: Record<string, string> } {
  const files = (body as { files?: unknown } | null)?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new HttpError(400, 'body must be {"files": {"<path>": <bytes>}}');
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0) throw new HttpError(400, 'build output is empty');
  if (entries.length > limits.files) throw new HttpError(413, `more than ${limits.files} files`);
  if (!entries.some(([path]) => path === 'index.html'))
    throw new HttpError(400, 'build output has no index.html');
  let total = 0;
  for (const [path, size] of entries) {
    if (contentTypeFor(path) === null) throw new HttpError(400, `path refused: ${path}`);
    if (!Number.isSafeInteger(size) || (size as number) < 0)
      throw new HttpError(400, `bad size for ${path}`);
    if ((size as number) > limits.fileBytes)
      throw new HttpError(413, `${path} is larger than ${limits.fileBytes} bytes`);
    total += size as number;
  }
  if (total > limits.totalBytes)
    throw new HttpError(413, `build is larger than ${limits.totalBytes} bytes`);
  // Optional content hashes (delta upload, #544): path -> hex digest of the file.
  const rawHashes = (body as { hashes?: unknown }).hashes;
  let hashes: Record<string, string> | undefined;
  if (rawHashes !== undefined) {
    if (!rawHashes || typeof rawHashes !== 'object' || Array.isArray(rawHashes))
      throw new HttpError(400, '"hashes" must be {"<path>": "<hex sha-256>"}');
    for (const [path, hash] of Object.entries(rawHashes as Record<string, unknown>))
      if (
        !(path in (files as object)) ||
        typeof hash !== 'string' ||
        !/^[0-9a-f]{32,64}$/.test(hash)
      )
        throw new HttpError(400, `bad hash for ${path}`);
    hashes = rawHashes as Record<string, string>;
  }
  return { files: files as Record<string, number>, total, ...(hashes ? { hashes } : {}) };
}

/** `owner/name` from a stored repo reference, which may be a GitHub URL. */
export function repoName(ref: string): string {
  return ref
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bearer(header: string | undefined): string {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'missing bearer token');
  return token;
}

/**
 * Authorize on immutable claims: the org id, main, an allowed event, and the
 * repository id pinned to exactly one app. The first deploy of an unpinned app
 * pins it, but only for the same-named repo in the verified org (the org alone
 * creates repos there) and only if the app's recorded repo, when set, agrees.
 */
export async function resolveDeployApp(db: D1Database, claims: OidcClaims): Promise<string> {
  if (claims.repository_owner_id !== APP_ORG_ID)
    throw new HttpError(
      403,
      `repository owner ${claims.repository_owner} is not freeappstore-online`,
    );
  if (claims.ref !== DEPLOY_REF)
    throw new HttpError(403, `ref ${claims.ref ?? '(none)'} may not deploy; only ${DEPLOY_REF}`);
  if (!DEPLOY_EVENTS.has(claims.event_name ?? ''))
    throw new HttpError(403, `event ${claims.event_name ?? '(none)'} may not deploy`);
  if (!claims.repository_id || !claims.jti)
    throw new HttpError(401, 'token lacks repository_id or jti');
  if (claims.repository === PLATFORM_REPO) {
    const site = PLATFORM_SITES[claims.job_workflow_ref ?? ''];
    if (!site)
      throw new HttpError(
        403,
        `workflow ${claims.job_workflow_ref ?? '(none)'} may not deploy from ${PLATFORM_REPO}`,
      );
    return site;
  }
  // The run starts from the repo's own deploy.yml on main, and the job is the
  // platform workflow at a listed commit, so the build steps are the platform's:
  // a repo's own steps (or another workflow) cannot deploy.
  const [workflow, sha] = (claims.job_workflow_ref ?? '').split('@');
  if (
    claims.workflow_ref !== `${claims.repository}/.github/workflows/deploy.yml@${DEPLOY_REF}` ||
    workflow !== APP_DEPLOY_WORKFLOW ||
    !APP_DEPLOY_WORKFLOW_SHAS.has(sha ?? '')
  )
    throw new HttpError(
      403,
      `workflow ${claims.job_workflow_ref ?? '(none)'} may not deploy; deploy.yml must call ${APP_DEPLOY_WORKFLOW} at a pinned commit`,
    );

  const pinned = await db
    .prepare('SELECT app_id FROM app_repositories WHERE repository_id = ?')
    .bind(claims.repository_id)
    .first<{ app_id: string }>();
  if (pinned) return pinned.app_id;

  const appId = (claims.repository.split('/')[1] ?? '').toLowerCase();
  const app = await db
    .prepare(
      `SELECT a.id, a.repo, p.repository_id AS pinned_to
         FROM apps a LEFT JOIN app_repositories p ON p.app_id = a.id
        WHERE a.id = ? AND (a.store IS NULL OR a.store = 'apps')`,
    )
    .bind(appId)
    .first<{ id: string; repo: string | null; pinned_to: string | null }>();
  if (!app) throw new HttpError(403, `repository ${claims.repository} is not a registered app`);
  if (app.pinned_to) throw new HttpError(403, `app ${appId} deploys from another repository`);
  if (app.repo && repoName(app.repo) !== repoName(claims.repository))
    throw new HttpError(403, `app ${appId} is registered to ${app.repo}`);
  // Two first deploys can race (a push and a dispatch): the first pin wins.
  await db
    .prepare(
      `INSERT INTO app_repositories (app_id, repository_id, repository, pinned_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(appId, claims.repository_id, claims.repository, Date.now())
    .run();
  const won = await db
    .prepare('SELECT 1 AS ok FROM app_repositories WHERE app_id = ? AND repository_id = ?')
    .bind(appId, claims.repository_id)
    .first();
  if (!won) throw new HttpError(403, `app ${appId} deploys from another repository`);
  return appId;
}

interface DeployRow {
  id: string;
  app_id: string;
  token_hash: string;
  manifest: string;
  status: string;
  created_at: number;
  expires_at: number;
}

/**
 * What a deploy session holds. Old-protocol sessions keep {path: bytes} in the
 * D1 row. Delta sessions (hashes sent) keep this in R2, because a large app's
 * manifest with hashes would not fit a D1 row, and the row points at it.
 */
interface StoredManifest {
  files: Record<string, number>;
  hashes: Record<string, string>;
  /** Paths whose bytes are unchanged since `base`: copied server side, not uploaded. */
  reuse: string[];
  base: string | null;
}

const manifestRef = (appId: string, id: string) => `apps/${appId}/.d/${id}.json`;
const manifestCache = new Map<string, StoredManifest>();

async function loadManifest(env: Env, id: string, raw: string): Promise<StoredManifest> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const ref = parsed.$manifest;
  if (typeof ref !== 'string')
    return { files: parsed as Record<string, number>, hashes: {}, reuse: [], base: null };
  const cached = manifestCache.get(id);
  if (cached) return cached;
  const object = await bucketOf(env).get(ref);
  if (!object) throw new HttpError(410, 'deploy manifest is gone');
  const stored = (await object.json()) as StoredManifest;
  manifestCache.set(id, stored);
  if (manifestCache.size > 4) manifestCache.delete(manifestCache.keys().next().value!);
  return stored;
}

async function openDeploy(env: Env, id: string, authorization: string | undefined) {
  const token = bearer(authorization);
  const row = await env.DB.prepare(
    'SELECT id, app_id, token_hash, manifest, status, created_at, expires_at FROM app_deploys WHERE id = ?',
  )
    .bind(id)
    .first<DeployRow>();
  if (!row || row.token_hash !== (await sha256Hex(token)))
    throw new HttpError(401, 'unknown deploy or upload token');
  if (row.status !== 'open') throw new HttpError(409, `deploy is ${row.status}`);
  const now = Date.now();
  if (row.expires_at < now) throw new HttpError(410, 'deploy session expired');
  // Slide the expiry while the client is active, so a large upload is not cut off
  // after the first 15 minutes (the cap above still bounds an abandoned-but-busy one).
  if (row.expires_at - now < SESSION_TTL_MS / 2) {
    const next = Math.min(now + SESSION_TTL_MS, row.created_at + SESSION_MAX_MS);
    if (next > row.expires_at) {
      await env.DB.prepare('UPDATE app_deploys SET expires_at = ? WHERE id = ?')
        .bind(next, id)
        .run();
      row.expires_at = next;
    }
  }
  const stored = await loadManifest(env, id, row.manifest);
  return { row, files: stored.files, stored };
}

function bucketOf(env: Env): R2Bucket {
  if (!env.APPS_BUCKET) throw new HttpError(503, 'app storage not configured');
  return env.APPS_BUCKET;
}

const releasePrefix = (appId: string, id: string) => `apps/${appId}/.r/${id}/`;

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/**
 * Delete the R2 files of deploys no route serves: abandoned sessions past their
 * expiry, and superseded releases except each app's latest (kept for rollback,
 * and for host isolates that still cache the previous route). Runs after every
 * commit (one app) and from the daily cron (all apps), a bounded batch each time.
 */
export async function pruneDeploys(env: Env, appId?: string, limit = 5): Promise<number> {
  if (!env.APPS_BUCKET) return 0;
  // Grace: an expired session may still be mid-commit, and a page or route
  // cached just before a switch may still ask for the release before last.
  const cutoff = Date.now() - PRUNE_GRACE_MS;
  const stale = await env.DB.prepare(
    `SELECT d.id, d.app_id FROM app_deploys d
      WHERE (?1 IS NULL OR d.app_id = ?1)
        AND d.id NOT IN (SELECT release FROM routes WHERE release IS NOT NULL)
        AND ((d.status = 'open' AND d.expires_at < ?2)
          OR (d.status = 'superseded'
              AND d.id != (SELECT s.id FROM app_deploys s
                            WHERE s.app_id = d.app_id AND s.status = 'superseded'
                            ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM app_deploys l WHERE l.app_id = d.app_id
                               AND l.status = 'live' AND l.committed_at > ?2)))
      ORDER BY d.created_at LIMIT ?3`,
  )
    .bind(appId ?? null, cutoff, limit)
    .all<{ id: string; app_id: string }>();
  for (const old of stale.results) {
    // Mark first, so a commit racing this prune can no longer switch to it.
    await env.DB.prepare("UPDATE app_deploys SET status = 'deleted' WHERE id = ?")
      .bind(old.id)
      .run();
    await deletePrefix(env.APPS_BUCKET, releasePrefix(old.app_id, old.id));
    await env.APPS_BUCKET.delete(manifestRef(old.app_id, old.id));
  }
  return stale.results.length;
}

export const deployRoutes = new Hono<{ Bindings: Env }>();

deployRoutes.post('/deploys', async (c) => {
  let claims: OidcClaims;
  try {
    claims = await verifyGithubOidc(bearer(c.req.header('Authorization')), {
      audience: DEPLOY_AUDIENCE,
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, `OIDC verification failed: ${(e as Error).message}`);
  }
  const appId = await resolveDeployApp(c.env.DB, claims);
  bucketOf(c.env);
  const { files, total, hashes } = parseManifest(
    await c.req.json().catch(() => null),
    await limitsFor(c.env.DB, appId),
  );

  const route = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM routes WHERE r2_prefix = ? AND hosted_on = 'r2' LIMIT 1",
  )
    .bind(`apps/${appId}`)
    .first();
  if (!route) throw new HttpError(409, `app ${appId} has no route; publish it first`);

  const now = Date.now();
  const recent = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM app_deploys WHERE app_id = ? AND created_at > ?',
  )
    .bind(appId, now - 3600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= DEPLOYS_PER_HOUR)
    throw new HttpError(429, `more than ${DEPLOYS_PER_HOUR} deploys of ${appId} this hour`);
  // Uncommitted uploads hold R2 space until they expire: bound them per app.
  const pending = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_deploys WHERE app_id = ? AND status = 'open' AND expires_at > ?",
  )
    .bind(appId, now)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= OPEN_DEPLOYS)
    throw new HttpError(429, `${OPEN_DEPLOYS} deploys of ${appId} are already uploading`);

  const id = randomHex(12);
  const token = randomHex(32);
  // Delta upload (#544): a client that sends hashes gets back only the files that
  // changed since the live release; the rest are copied by /reuse. Old clients
  // send no hashes and upload everything, as before.
  let storedManifest = JSON.stringify(files);
  let delta: { missing: string[]; reuse: string[] } | undefined;
  if (hashes) {
    const base = await c.env.DB.prepare(
      "SELECT id, manifest FROM app_deploys WHERE app_id = ? AND status = 'live' LIMIT 1",
    )
      .bind(appId)
      .first<{ id: string; manifest: string }>();
    const before = base ? await loadManifest(c.env, base.id, base.manifest) : null;
    const reuse = Object.keys(files).filter(
      (path) =>
        !META_PATHS.has(path) &&
        before !== null &&
        before.hashes[path] !== undefined &&
        before.hashes[path] === hashes[path] &&
        before.files[path] === files[path],
    );
    const reused = new Set(reuse);
    delta = { missing: Object.keys(files).filter((path) => !reused.has(path)), reuse };
    const ref = manifestRef(appId, id);
    await bucketOf(c.env).put(
      ref,
      JSON.stringify({ files, hashes, reuse, base: reuse.length ? base!.id : null }),
      { httpMetadata: { contentType: 'application/json' } },
    );
    storedManifest = JSON.stringify({ $manifest: ref });
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO app_deploys (id, app_id, jti, repository_id, sha, run_id, token_hash, manifest,
         total_bytes, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
      .bind(
        id,
        appId,
        claims.jti!,
        claims.repository_id!,
        claims.sha ?? null,
        claims.run_id ?? null,
        await sha256Hex(token),
        storedManifest,
        total,
        now,
        now + SESSION_TTL_MS,
      )
      .run();
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw new HttpError(409, 'OIDC token already used');
    throw e;
  }
  console.log(`deploy ${id} opened for ${appId} by ${claims.repository} run ${claims.run_id}`);
  return c.json(
    { id, token, app_id: appId, expires_at: now + SESSION_TTL_MS, ...(delta ?? {}) },
    201,
  );
});

deployRoutes.put('/deploys/:id/files/*', async (c) => {
  const id = c.req.param('id');
  const { row, files } = await openDeploy(c.env, id, c.req.header('Authorization'));
  const marker = `/deploys/${id}/files/`;
  const pathname = new URL(c.req.url).pathname;
  let path: string;
  try {
    path = decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
  } catch {
    throw new HttpError(400, 'malformed path');
  }
  const expected = files[path];
  if (expected === undefined) throw new HttpError(400, `${path} is not in the manifest`);
  if (Number(c.req.header('Content-Length')) !== expected)
    throw new HttpError(400, `${path}: Content-Length must be ${expected}`);

  const key = META_PATHS.has(path)
    ? `apps/${row.app_id}/${path}`
    : `${releasePrefix(row.app_id, id)}${path}`;
  const bucket = bucketOf(c.env);
  const put = await bucket.put(key, expected === 0 ? '' : c.req.raw.body, {
    httpMetadata: { contentType: contentTypeFor(path)! },
  });
  if (put?.size !== expected) {
    await bucket.delete(key);
    throw new HttpError(400, `${path}: received ${put?.size} bytes, expected ${expected}`);
  }
  return c.body(null, 204);
});

deployRoutes.post('/deploys/:id/reuse', async (c) => {
  const id = c.req.param('id');
  const { row, files, stored } = await openDeploy(c.env, id, c.req.header('Authorization'));
  const body = (await c.req.json().catch(() => null)) as { paths?: unknown } | null;
  const paths = body?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > REUSE_BATCH)
    throw new HttpError(400, `body must be {"paths": [1..${REUSE_BATCH} paths]}`);
  const allowed = new Set(stored.reuse);
  const bucket = bucketOf(c.env);
  for (const path of paths)
    if (typeof path !== 'string' || !allowed.has(path))
      throw new HttpError(400, `${String(path)} is not a reusable file of this deploy`);
  const copy = async (path: string) => {
    const from = await bucket.get(`${releasePrefix(row.app_id, stored.base!)}${path}`);
    if (!from || from.size !== files[path]) {
      from?.body?.cancel();
      throw new HttpError(409, `${path}: the previous release no longer has it; deploy again`);
    }
    await bucket.put(`${releasePrefix(row.app_id, id)}${path}`, from.size === 0 ? '' : from.body, {
      httpMetadata: { contentType: contentTypeFor(path)! },
    });
  };
  // A Worker runs six subrequests at a time; copy that many files at once.
  const queue = [...(paths as string[])];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) await copy(path);
    }),
  );
  return c.body(null, 204);
});

deployRoutes.post('/deploys/:id/commit', async (c) => {
  const id = c.req.param('id');
  const { row, files } = await openDeploy(c.env, id, c.req.header('Authorization'));
  const bucket = bucketOf(c.env);
  const prefix = releasePrefix(row.app_id, id);

  const stored = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    for (const o of listed.objects) stored.set(o.key.slice(prefix.length), o.size);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  const missing = Object.entries(files).filter(
    ([path, size]) => !META_PATHS.has(path) && stored.get(path) !== size,
  );
  if (missing.length)
    throw new HttpError(
      409,
      `${missing.length} file(s) missing or incomplete, e.g. ${missing[0]![0]}`,
    );

  // Check staged release bytes before making the route live. This is the
  // authoritative gate; CLI and workflow checks only provide fast feedback.
  const failedChecks = new Set<string>();
  for (const path of Object.keys(files)) {
    if (META_PATHS.has(path) || !/\.(?:html?|m?js|cjs|json)$/i.test(path)) continue;
    const object = await bucket.get(`${prefix}${path}`);
    if (!object) throw new HttpError(409, `artifact file disappeared: ${path}`);
    const results = checkArtifactFiles(new Map([[path, await new Response(object.body).text()]]));
    for (const result of results) if (result.status === 'fail') failedChecks.add(result.name);
    if (failedChecks.size)
      throw new HttpError(422, `compliance check failed: ${[...failedChecks].join(', ')}`);
  }

  // One transaction: switch the route unless a newer deploy is already live (a
  // slower, older run must not replace it), and record the switch with it.
  const now = Date.now();
  const appPrefix = `apps/${row.app_id}`;
  const switched = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE routes SET release = ?, updated_at = ? WHERE r2_prefix = ? AND hosted_on = 'r2'
         AND EXISTS (SELECT 1 FROM app_deploys WHERE id = ? AND status = 'open')
         AND NOT EXISTS (SELECT 1 FROM app_deploys
                          WHERE app_id = ? AND status = 'live' AND created_at > ?)`,
    ).bind(id, now, appPrefix, id, row.app_id, row.created_at),
    c.env.DB.prepare(
      `UPDATE app_deploys SET status = 'superseded' WHERE app_id = ? AND status = 'live'
         AND EXISTS (SELECT 1 FROM routes WHERE r2_prefix = ? AND release = ?)`,
    ).bind(row.app_id, appPrefix, id),
    c.env.DB.prepare(
      `UPDATE app_deploys SET status = 'live', committed_at = ? WHERE id = ?
         AND EXISTS (SELECT 1 FROM routes WHERE r2_prefix = ? AND release = ?)`,
    ).bind(now, id, appPrefix, id),
  ]);
  if (!switched[0]?.meta.changes)
    throw new HttpError(409, 'a newer deploy is already live, or the app has no route');

  await pruneDeploys(c.env, row.app_id);
  console.log(`deploy ${id} live for ${row.app_id} (${Object.keys(files).length} files)`);
  return c.json({ app_id: row.app_id, release: id, files: Object.keys(files).length });
});
