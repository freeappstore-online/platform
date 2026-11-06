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
const SESSION_TTL_MS = 15 * 60 * 1000;
const DEPLOYS_PER_HOUR = 20;
const OPEN_DEPLOYS = 3;
const PRUNE_GRACE_MS = 10 * 60 * 1000;
export const MAX_FILES = 5000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
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
};

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
export function parseManifest(body: unknown): { files: Record<string, number>; total: number } {
  const files = (body as { files?: unknown } | null)?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new HttpError(400, 'body must be {"files": {"<path>": <bytes>}}');
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0) throw new HttpError(400, 'build output is empty');
  if (entries.length > MAX_FILES) throw new HttpError(413, `more than ${MAX_FILES} files`);
  if (!entries.some(([path]) => path === 'index.html'))
    throw new HttpError(400, 'build output has no index.html');
  let total = 0;
  for (const [path, size] of entries) {
    if (contentTypeFor(path) === null) throw new HttpError(400, `path refused: ${path}`);
    if (!Number.isSafeInteger(size) || (size as number) < 0)
      throw new HttpError(400, `bad size for ${path}`);
    if ((size as number) > MAX_FILE_BYTES)
      throw new HttpError(413, `${path} is larger than ${MAX_FILE_BYTES} bytes`);
    total += size as number;
  }
  if (total > MAX_TOTAL_BYTES)
    throw new HttpError(413, `build is larger than ${MAX_TOTAL_BYTES} bytes`);
  return { files: files as Record<string, number>, total };
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
  // Only the repo's own deploy.yml on main may deploy; another workflow added
  // to the repo cannot (it would skip the generated build job's validators).
  if (claims.job_workflow_ref !== `${claims.repository}/.github/workflows/deploy.yml@${DEPLOY_REF}`)
    throw new HttpError(403, `workflow ${claims.job_workflow_ref ?? '(none)'} may not deploy`);

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
  if (row.expires_at < Date.now()) throw new HttpError(410, 'deploy session expired');
  return { row, files: JSON.parse(row.manifest) as Record<string, number> };
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
  const { files, total } = parseManifest(await c.req.json().catch(() => null));
  const appId = await resolveDeployApp(c.env.DB, claims);
  bucketOf(c.env);

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
        JSON.stringify(files),
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
  return c.json({ id, token, app_id: appId, expires_at: now + SESSION_TTL_MS }, 201);
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
