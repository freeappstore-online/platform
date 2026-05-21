// Per-app visitor analytics. Two halves:
//
//   * Public loader: GET /v1/analytics.js?app=<id>
//     Returns small JavaScript that injects the right analytics tags
//     (Cloudflare Web Analytics beacon + any owner-configured BYO tags
//     like GA4 / Plausible / a custom <head> snippet) into the page.
//     Every FreeAppStore app includes one <script> referencing this URL
//     so the platform can evolve analytics policy without redeploying
//     every app repo.
//
//   * Owner-protected CRUD:
//     GET /v1/apps/:appId/analytics — read current settings
//     PUT /v1/apps/:appId/analytics — update settings
//     The cf_beacon_token is auto-provisioned at publish time by the
//     admin Worker; owners cannot rotate it via this endpoint.

import { type Context, Hono } from 'hono';
import { type CurrentUser, HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const GA4_RE = /^G-[A-Z0-9]{6,12}$/i;
const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{0,253}\.[a-z]{2,}$/i;
const CF_TOKEN_RE = /^[a-f0-9]{32,}$/i;
const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const CUSTOM_HEAD_MAX = 4096;

interface AnalyticsRow {
  cf_beacon_token: string | null;
  ga4: string | null;
  plausible: string | null;
  custom_head: string | null;
  updated_at: number | null;
}

interface AnalyticsBody {
  ga4?: string | null;
  plausible?: string | null;
  custom_head?: string | null;
}

function rowToJson(row: AnalyticsRow | null) {
  return {
    cfBeaconToken: row?.cf_beacon_token ?? null,
    ga4: row?.ga4 ?? null,
    plausible: row?.plausible ?? null,
    customHead: row?.custom_head ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

async function loadRow(c: Ctx, appId: string): Promise<AnalyticsRow | null> {
  return await c.env.DB.prepare(
    `SELECT cf_beacon_token, ga4, plausible, custom_head, updated_at
     FROM app_analytics WHERE app_id = ?`,
  )
    .bind(appId)
    .first<AnalyticsRow>();
}

async function requireOwner(c: Ctx, appId: string): Promise<CurrentUser> {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare('SELECT owner_login FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ owner_login: string }>();
  if (!row) throw new HttpError(404, 'app not found');
  if (row.owner_login !== user.login) throw new HttpError(403, 'not the app owner');
  return user;
}

function wrap(handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof HttpError) return c.text(err.message, err.status as 401);
      throw err;
    }
  };
}

// -----------------------------------------------------------------------------
// Owner-protected: read + write analytics config
// -----------------------------------------------------------------------------

analyticsRoutes.get(
  '/apps/:appId/analytics',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireOwner(c, appId);
    const row = await loadRow(c, appId);
    return c.json(rowToJson(row));
  }),
);

analyticsRoutes.put(
  '/apps/:appId/analytics',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireOwner(c, appId);
    let body: AnalyticsBody;
    try {
      body = (await c.req.json()) as AnalyticsBody;
    } catch {
      throw new HttpError(400, 'invalid json');
    }

    const ga4 = normalize(body.ga4);
    const plausible = normalize(body.plausible);
    const customHead = normalize(body.custom_head);

    if (ga4 && !GA4_RE.test(ga4)) throw new HttpError(400, 'invalid ga4 measurement id');
    if (plausible && !DOMAIN_RE.test(plausible))
      throw new HttpError(400, 'invalid plausible domain');
    if (customHead && customHead.length > CUSTOM_HEAD_MAX)
      throw new HttpError(400, `custom_head exceeds ${CUSTOM_HEAD_MAX} bytes`);

    // Preserve cf_beacon_token (admin-managed, not settable from this endpoint)
    const existing = await loadRow(c, appId);
    await c.env.DB.prepare(
      `INSERT INTO app_analytics (app_id, cf_beacon_token, ga4, plausible, custom_head, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         ga4 = excluded.ga4,
         plausible = excluded.plausible,
         custom_head = excluded.custom_head,
         updated_at = excluded.updated_at`,
    )
      .bind(appId, existing?.cf_beacon_token ?? null, ga4, plausible, customHead, Date.now())
      .run();

    const fresh = await loadRow(c, appId);
    return c.json(rowToJson(fresh));
  }),
);

function normalize(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim();
  return trimmed === '' ? null : trimmed;
}

// -----------------------------------------------------------------------------
// Internal: admin Worker writes the CF Web Analytics site_token here after
// minting it via the CF API. Authenticated via a shared X-Internal-Token
// header (also set as a CF Worker secret). Bypasses requireOwner since the
// admin Worker runs this on behalf of the creator at provision time.
// -----------------------------------------------------------------------------

analyticsRoutes.put('/internal/apps/:appId/analytics/cf-token', async (c) => {
  const appId = c.req.param('appId')!;
  if (!APP_ID_RE.test(appId)) return c.text('invalid app id', 400);
  const provided = c.req.header('X-Internal-Token');
  const expected = (c.env as Env & { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  if (!expected || provided !== expected) return c.text('forbidden', 403);

  let body: { cf_beacon_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.text('invalid json', 400);
  }
  const token = (body.cf_beacon_token ?? '').trim();
  if (!CF_TOKEN_RE.test(token)) return c.text('invalid cf_beacon_token', 400);

  await c.env.DB.prepare(
    `INSERT INTO app_analytics (app_id, cf_beacon_token, ga4, plausible, custom_head, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       cf_beacon_token = excluded.cf_beacon_token,
       updated_at = excluded.updated_at`,
  )
    .bind(appId, token, Date.now())
    .run();
  return c.json({ ok: true, appId, cfBeaconToken: token });
});

// -----------------------------------------------------------------------------
// Stats query (owner-only): aggregate page views, top paths, referrers,
// countries, device split from Workers Analytics Engine via the SQL API.
// -----------------------------------------------------------------------------

const STATS_DAYS_DEFAULT = 7;
const STATS_DAYS_MAX = 90;
const STATS_DATASET = 'fas_app_analytics';

interface StatsRow {
  total_views: number;
  unique_paths: number;
  daily: Array<{ day: string; views: number }>;
  top_paths: Array<{ path: string; views: number }>;
  top_referrers: Array<{ referrer: string; views: number }>;
  top_countries: Array<{ country: string; views: number }>;
  device_split: Array<{ device: string; views: number }>;
}

async function cfAnalyticsSql<T = Record<string, unknown>>(
  env: Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string },
  sql: string,
): Promise<T[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_API_TOKEN) {
    throw new HttpError(503, 'stats not configured (missing CF_ACCOUNT_ID/CF_ANALYTICS_API_TOKEN)');
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new HttpError(502, `CF Analytics SQL failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: T[] };
  return json.data ?? [];
}

analyticsRoutes.get(
  '/apps/:appId/analytics/stats',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireOwner(c, appId);
    const days = Math.min(
      STATS_DAYS_MAX,
      Math.max(1, Number(c.req.query('days') ?? STATS_DAYS_DEFAULT) | 0),
    );
    // `?kind=` filters which event kind the stats describe. Defaults to
    // 'pageview' so existing dashboard consumers keep working. Validated
    // against the same regex the ingest endpoint uses so we can't be
    // tricked into SQL-injecting through the WHERE clause.
    const kindParam = (c.req.query('kind') ?? 'pageview').trim().toLowerCase();
    if (!EVENT_KIND_RE.test(kindParam)) throw new HttpError(400, 'invalid kind');
    // Effective event time: prefer the client-recorded `t` stored in
    // doubles[1] (for offline-replayed events), fall back to the server
    // timestamp for events written before doubles[1] existed.
    // ClickHouse-flavoured SQL accepted by CF Analytics Engine.
    const effectiveTime =
      `if(length(doubles) > 1, fromUnixTimestamp64Milli(toInt64(double2)), timestamp)`;
    const sinceClause = `${effectiveTime} > NOW() - INTERVAL '${days}' DAY`;
    // Quote-safe: appId + kindParam are regex-validated. STATS_DATASET is a constant.
    const where = `WHERE index1 = '${appId}' AND blob2 = '${kindParam}' AND ${sinceClause}`;

    const totalsQ = `SELECT SUM(_sample_interval) AS views, COUNT(DISTINCT blob3) AS uniq_paths FROM ${STATS_DATASET} ${where}`;
    const dailyQ = `SELECT toStartOfDay(${effectiveTime}) AS day, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY day ORDER BY day ASC`;
    const pathsQ = `SELECT blob3 AS path, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY path ORDER BY views DESC LIMIT 10`;
    const refsQ = `SELECT blob4 AS referrer, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} AND blob4 != '' GROUP BY referrer ORDER BY views DESC LIMIT 10`;
    const ctyQ = `SELECT blob5 AS country, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} AND blob5 != '' GROUP BY country ORDER BY views DESC LIMIT 10`;
    const devQ = `SELECT blob6 AS device, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY device`;

    const env = c.env as Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string };
    try {
      const [totals, daily, paths, refs, ctys, devs] = await Promise.all([
        cfAnalyticsSql<{ views: number; uniq_paths: number }>(env, totalsQ),
        cfAnalyticsSql<{ day: string; views: number }>(env, dailyQ),
        cfAnalyticsSql<{ path: string; views: number }>(env, pathsQ),
        cfAnalyticsSql<{ referrer: string; views: number }>(env, refsQ),
        cfAnalyticsSql<{ country: string; views: number }>(env, ctyQ),
        cfAnalyticsSql<{ device: string; views: number }>(env, devQ),
      ]);
      const body: StatsRow = {
        total_views: Number(totals[0]?.views ?? 0),
        unique_paths: Number(totals[0]?.uniq_paths ?? 0),
        daily: daily.map((r) => ({ day: r.day, views: Number(r.views) })),
        top_paths: paths.map((r) => ({ path: r.path, views: Number(r.views) })),
        top_referrers: refs.map((r) => ({ referrer: r.referrer, views: Number(r.views) })),
        top_countries: ctys.map((r) => ({ country: r.country, views: Number(r.views) })),
        device_split: devs.map((r) => ({ device: r.device, views: Number(r.views) })),
      };
      return c.json({ appId, days, kind: kindParam, stats: body });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, err instanceof Error ? err.message : 'stats query failed');
    }
  }),
);

// -----------------------------------------------------------------------------
// Custom events index: lists the distinct event kinds that have fired for
// this app, with counts. Powers the "Custom events" panel in the creator
// dashboard. Excludes 'pageview' from the list since pageviews are already
// the headline metric — separating them prevents pageview from drowning out
// the actual custom events.
// -----------------------------------------------------------------------------

analyticsRoutes.get(
  '/apps/:appId/analytics/events',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireOwner(c, appId);
    const days = Math.min(
      STATS_DAYS_MAX,
      Math.max(1, Number(c.req.query('days') ?? STATS_DAYS_DEFAULT) | 0),
    );
    const effectiveTime =
      `if(length(doubles) > 1, fromUnixTimestamp64Milli(toInt64(double2)), timestamp)`;
    const sinceClause = `${effectiveTime} > NOW() - INTERVAL '${days}' DAY`;
    const where = `WHERE index1 = '${appId}' AND blob2 != 'pageview' AND ${sinceClause}`;

    // Top 20 event kinds by count. 20 is plenty for any sensible app —
    // creators with more than ~5 event kinds are usually over-instrumenting.
    const kindsQ = `SELECT blob2 AS kind, SUM(_sample_interval) AS count FROM ${STATS_DATASET} ${where} GROUP BY kind ORDER BY count DESC LIMIT 20`;

    const env = c.env as Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string };
    try {
      const rows = await cfAnalyticsSql<{ kind: string; count: number }>(env, kindsQ);
      const events = rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
      const total = events.reduce((sum, e) => sum + e.count, 0);
      return c.json({ appId, days, total_events: total, events });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, err instanceof Error ? err.message : 'events query failed');
    }
  }),
);

// -----------------------------------------------------------------------------
// Event ingest: every page load from the platform loader script sends a
// sendBeacon to /v1/analytics/event. We write one row to Workers Analytics
// Engine per event (app_id, path, referrer host, country, user-agent class).
// No PII — IP and full UA are dropped server-side; only the bot/mobile/
// desktop classification is recorded. Public endpoint (no auth) because
// it's called from every visitor's browser; rate-limited by CF edge.
// -----------------------------------------------------------------------------

const EVENT_KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PATH_MAX = 256;
const REFERRER_HOST_MAX = 120;
const PROPS_MAX = 8;

interface EventBody {
  /** Required app id (slug). Validated server-side; events with a bad id are dropped. */
  app?: string;
  /** Event kind: 'pageview' (default) or a creator-defined custom event like 'purchase'. */
  kind?: string;
  /** Page path (URL pathname). Truncated to PATH_MAX. */
  path?: string;
  /** Document.referrer's hostname only (we drop the path to keep things PII-light). */
  referrer?: string;
  /** Optional small bag of custom-event properties. Strings only; ≤8 entries; ≤64 chars each. */
  props?: Record<string, unknown>;
  /** Client-recorded event time (epoch ms). Used for offline-replayed events
   *  so they end up on the right day in the dashboard. Rejected if more than
   *  72h old or in the future (clock-skew defense). */
  t?: number;
  /** Batch wrapper: when set, every entry is treated as an EventBody (with
   *  optional `t`). Used by the loader to flush its IDB outbox in one POST. */
  events?: EventBody[];
}

const MAX_BATCH = 100;
const T_WINDOW_MS = 72 * 60 * 60 * 1000; // accept replays up to 72h old

function effectiveTimestamp(t: number | undefined, nowMs: number): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) return nowMs;
  // Allow events up to 72h in the past, ~5min in the future (clock skew). Out-of-window → snap to now.
  if (t > nowMs + 5 * 60 * 1000) return nowMs;
  if (t < nowMs - T_WINDOW_MS) return nowMs;
  return t;
}

function classifyUA(ua: string | null): 'bot' | 'mobile' | 'desktop' {
  if (!ua) return 'desktop';
  if (/bot|crawler|spider|curl|wget|python|node/i.test(ua)) return 'bot';
  if (/iphone|android|mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

function safeReferrerHost(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.hostname.slice(0, REFERRER_HOST_MAX);
  } catch {
    return '';
  }
}

function flattenProps(props: Record<string, unknown> | undefined): string {
  if (!props) return '';
  const entries = Object.entries(props).slice(0, PROPS_MAX);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length > 32) continue;
    out[k] = String(v).slice(0, 64);
  }
  return JSON.stringify(out);
}

// Per-(app, IP, kind) sampling rate ceiling. ~99% of legit traffic stays
// well under this; runaway clients (bot loops, broken SPA emitting on
// every render) get auto-sampled-down. In-memory cache means the limit is
// per-isolate, not global — close enough for cost protection.
const SAMPLE_BUCKET_SECONDS = 10;
const SAMPLE_MAX_PER_BUCKET = 50;
const sampleBuckets = new Map<string, { windowStart: number; count: number }>();

function shouldAccept(key: string, now: number): boolean {
  const windowStart = Math.floor(now / 1000 / SAMPLE_BUCKET_SECONDS) * SAMPLE_BUCKET_SECONDS;
  const cur = sampleBuckets.get(key);
  if (!cur || cur.windowStart !== windowStart) {
    sampleBuckets.set(key, { windowStart, count: 1 });
    if (sampleBuckets.size > 1024) {
      // Bound memory — evict the oldest by clearing the map; the cost of a
      // rebuild is negligible vs. paying for unbounded AE writes.
      sampleBuckets.clear();
    }
    return true;
  }
  cur.count += 1;
  return cur.count <= SAMPLE_MAX_PER_BUCKET;
}

analyticsRoutes.post('/analytics/event', async (c) => {
  let body: EventBody;
  try {
    body = await c.req.json();
  } catch {
    return c.text('invalid json', 400);
  }

  const ua = c.req.header('user-agent') ?? null;
  const uaClass = classifyUA(ua);
  if (uaClass === 'bot') return new Response(null, { status: 204 });

  const ip = c.req.header('cf-connecting-ip') ?? '';
  const country =
    (c.req.raw as Request & { cf?: { country?: string } }).cf?.country?.slice(0, 2) ?? '';
  const dataset = (c.env as Env & { ANALYTICS?: AnalyticsEngineDataset }).ANALYTICS;

  // Two body shapes: single event { app, kind, ... } or batched { events: [...] }
  // (used by the loader to flush its IndexedDB outbox after reconnecting).
  // Each entry carries its own client-recorded `t` so the dashboard places
  // it on the day it actually happened, not the flush day.
  const items: EventBody[] = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [body];
  const nowMs = Date.now();
  let accepted = 0;
  for (const item of items) {
    const appId = (item.app ?? '').trim();
    if (!APP_ID_RE.test(appId)) continue;
    const kind = (item.kind ?? 'pageview').trim().toLowerCase();
    if (!EVENT_KIND_RE.test(kind)) continue;
    if (!shouldAccept(`${appId}:${ip}:${kind}`, nowMs)) continue;
    if (!dataset) {
      accepted++;
      continue;
    }
    const path = (item.path ?? '/').slice(0, PATH_MAX);
    const referrerHost = safeReferrerHost(item.referrer);
    const t = effectiveTimestamp(item.t, nowMs);
    dataset.writeDataPoint({
      indexes: [appId],
      blobs: [appId, kind, path, referrerHost, country, uaClass, flattenProps(item.props)],
      // doubles[0] = 1 (event count); doubles[1] = original event time (ms).
      // Stats queries prefer doubles[1] when present so replayed offline events
      // appear on the right day, not the flush day.
      doubles: [1, t],
    });
    accepted++;
  }
  return new Response(null, { status: 204, headers: { 'x-events-accepted': String(accepted) } });
});

// -----------------------------------------------------------------------------
// Public loader: returns JS that injects analytics tags into the page
// -----------------------------------------------------------------------------

export function buildLoaderJs(
  row: AnalyticsRow | null,
  appId: string,
  apiBase = 'https://api.freeappstore.online',
): string {
  const parts: string[] = [];
  if (row?.cf_beacon_token && CF_TOKEN_RE.test(row.cf_beacon_token)) {
    parts.push(
      `_fasAnalytics.script("https://static.cloudflareinsights.com/beacon.min.js",{defer:true,"data-cf-beacon":${JSON.stringify(JSON.stringify({ token: row.cf_beacon_token }))}});`,
    );
  }
  if (row?.ga4 && GA4_RE.test(row.ga4)) {
    const id = JSON.stringify(row.ga4);
    parts.push(
      `_fasAnalytics.script("https://www.googletagmanager.com/gtag/js?id="+${id},{async:true});`,
      `_fasAnalytics.inline("window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config',"+${id}+");");`,
    );
  }
  if (row?.plausible && DOMAIN_RE.test(row.plausible)) {
    const domain = JSON.stringify(row.plausible);
    parts.push(
      `_fasAnalytics.script("https://plausible.io/js/script.js",{defer:true,"data-domain":${domain}});`,
    );
  }
  if (row?.custom_head && row.custom_head.length <= CUSTOM_HEAD_MAX) {
    parts.push(`_fasAnalytics.raw(${JSON.stringify(row.custom_head)});`);
  }
  // First-party event pipeline. Buffers offline events in IndexedDB and
  // drains the outbox once back online — PWA-friendly. Each event carries
  // its client-recorded timestamp so replayed events land on the right day
  // in the dashboard. ~2 KB minified.
  const beaconBase = JSON.stringify(apiBase);
  const idLit = JSON.stringify(appId);
  parts.push(`(function(){
    var URL = ${beaconBase}+"/v1/analytics/event";
    var APP = ${idLit};
    var DB_NAME = "fasA", STORE = "outbox", MAX_BUFFER = 200;
    function openDB(){
      return new Promise(function(res, rej){
        try{
          var r = indexedDB.open(DB_NAME, 1);
          r.onupgradeneeded = function(e){ e.target.result.createObjectStore(STORE,{keyPath:"id",autoIncrement:true}); };
          r.onsuccess = function(){ res(r.result); };
          r.onerror = function(){ rej(); };
        }catch(e){ rej(); }
      });
    }
    function buffer(evt){
      openDB().then(function(db){
        try{
          var tx = db.transaction(STORE, "readwrite");
          var s = tx.objectStore(STORE);
          var c = s.count();
          c.onsuccess = function(){
            if (c.result < MAX_BUFFER) s.add(evt);
            // Else: drop oldest by clearing if buffer is full. Visitor on a
            // long offline session is unusual; bounded loss > unbounded growth.
          };
        }catch(e){}
      }).catch(function(){});
    }
    function postBatch(events){
      if (!events.length) return Promise.resolve(true);
      var body = JSON.stringify({events: events});
      if (navigator.sendBeacon && navigator.sendBeacon(URL, body)) return Promise.resolve(true);
      return fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true})
        .then(function(r){ return r.ok; }).catch(function(){ return false; });
    }
    function drain(){
      openDB().then(function(db){
        try{
          var tx = db.transaction(STORE, "readwrite");
          var s = tx.objectStore(STORE);
          var req = s.getAll();
          req.onsuccess = function(){
            var rows = req.result || [];
            if (!rows.length) return;
            postBatch(rows.map(function(r){ return r.evt; })).then(function(ok){
              if (!ok) return;
              var tx2 = db.transaction(STORE, "readwrite");
              tx2.objectStore(STORE).clear();
            });
          };
        }catch(e){}
      }).catch(function(){});
    }
    function send(kind, props){
      var evt = {app:APP,kind:kind,path:location.pathname,referrer:document.referrer,props:props||null,t:Date.now()};
      if (navigator.onLine === false) { buffer(evt); return; }
      try{
        var body = JSON.stringify(evt);
        var ok = navigator.sendBeacon ? navigator.sendBeacon(URL, body) : false;
        if (!ok) {
          fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true})
            .catch(function(){ buffer(evt); });
        }
      }catch(e){ buffer(evt); }
    }
    send("pageview");
    // Drain on load (covers the case where buffered events from a prior
    // offline session still need to flush) and on the 'online' event.
    drain();
    window.addEventListener("online", drain);
    // Custom-event API for creator code.
    window.fasAnalytics = window.fasAnalytics || {};
    window.fasAnalytics.event = function(kind, props){ send(String(kind||"event"), props); };
    // SPA route-change tracking.
    var _push = history.pushState, _replace = history.replaceState;
    history.pushState = function(){ _push.apply(this, arguments); send("pageview"); };
    history.replaceState = function(){ _replace.apply(this, arguments); send("pageview"); };
    window.addEventListener("popstate", function(){ send("pageview"); });
  })();`);
  return `(function(){
  var _fasAnalytics = {
    script: function(src, attrs){
      var s = document.createElement("script");
      s.src = src;
      for (var k in attrs) { if (attrs[k] === true) s.setAttribute(k,""); else s.setAttribute(k, attrs[k]); }
      document.head.appendChild(s);
    },
    inline: function(code){
      var s = document.createElement("script");
      s.text = code;
      document.head.appendChild(s);
    },
    raw: function(html){
      var t = document.createElement("template");
      t.innerHTML = html;
      while (t.content.firstChild) document.head.appendChild(t.content.firstChild);
    }
  };
  ${parts.join('\n  ')}
})();
`;
}

// Worker Cache API key prefix for the loader response. Burst-tested for an app
// invalidates by writing a "purge marker" — we just rely on the 1h TTL and the
// fact that BYO-tag edits are rare.
const LOADER_CACHE_TTL_SECONDS = 3600;

analyticsRoutes.get('/analytics.js', async (c) => {
  const appId = c.req.query('app') ?? '';
  if (!APP_ID_RE.test(appId)) {
    return new Response('/* invalid app id */\n', {
      status: 200,
      headers: jsHeaders(),
    });
  }
  // Try Worker cache first — this turns most loader requests into edge cache
  // hits with zero D1 lookup. The cache key intentionally drops everything
  // except the path + query, so it deduplicates across visitor user-agents.
  const cacheUrl = `https://loader-cache/${appId}`;
  const cache = caches.default;
  const cached = await cache.match(cacheUrl);
  if (cached) return cached;

  const row = await loadRow(c, appId);
  const body = buildLoaderJs(row, appId);
  const res = new Response(body, { status: 200, headers: jsHeaders() });
  // Clone for cache write; the original is returned to the visitor.
  c.executionCtx.waitUntil(cache.put(cacheUrl, res.clone()));
  return res;
});

function jsHeaders(): Record<string, string> {
  return {
    'content-type': 'application/javascript; charset=utf-8',
    // Browser keeps it for an hour; CF edge for the same. Owners changing
    // BYO tags accept up to 1h propagation — small price for ~100x fewer
    // origin hits. Bust by appending a query param like `?app=X&v=2` if needed.
    'cache-control': `public, max-age=${LOADER_CACHE_TTL_SECONDS}, s-maxage=${LOADER_CACHE_TTL_SECONDS}`,
    'access-control-allow-origin': '*',
  };
}
