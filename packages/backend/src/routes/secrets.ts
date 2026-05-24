import { type Context, Hono } from 'hono';
import { type CurrentUser, HttpError, requireUser } from '../lib/auth.js';
import { openSecret, type SealedSecret, sealSecret } from '../lib/encryption.js';
import {
  AllowlistError,
  type AllowlistRule,
  injectSecret,
  pickRule,
  validateRule,
} from '../lib/proxy-allowlist.js';
import { checkAndBump, d1UsageStore } from '../lib/proxy-rate-limit.js';
import type { Env } from '../types.js';
import { resolveUserKey } from './keys.js';

export const secretsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Free-tier caps. The spec (docs/APP-SECRET-PROXY.md) lists Pro tiers too,
 * but for now every app is treated as free — Pro caps land later.
 */
const MAX_SECRETS_PER_APP = 5;
const MAX_ALLOWLIST_PER_APP = 5;
const DAILY_PROXY_REQUESTS = 10_000;
const MAX_REQUEST_BODY_BYTES = 100 * 1024;
const MAX_RESPONSE_BODY_BYTES = 100 * 1024;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/; // uppercase + underscore convention

type Ctx = Context<{ Bindings: Env }>;

/**
 * Wrap a handler so HttpError surfaces as a typed Response and the rest of
 * the routes don't need their own try/catch. Mirrors the pattern in apps.ts.
 */
function wrap(handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
      if (err instanceof AllowlistError) return c.json({ error: err.message }, 400);
      throw err;
    }
  };
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

function requireKek(c: Ctx): string {
  const kek = c.env.APP_SECRET_KEK;
  if (!kek) throw new HttpError(503, 'app-secret proxy not configured');
  return kek;
}

// -----------------------------------------------------------------------------
// Secrets CRUD
// -----------------------------------------------------------------------------

interface SecretListRow {
  name: string;
  created_at: number;
  last_used_at: number | null;
}

secretsRoutes.get(
  '/apps/:appId/secrets',
  wrap(async (c) => {
    await requireOwner(c, c.req.param('appId')!);
    const result = await c.env.DB.prepare(
      `SELECT name, created_at, last_used_at FROM app_secrets
       WHERE app_id = ? ORDER BY name`,
    )
      .bind(c.req.param('appId')!)
      .all<SecretListRow>();
    return c.json({
      secrets: (result.results ?? []).map((r) => ({
        name: r.name,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      })),
    });
  }),
);

secretsRoutes.put(
  '/apps/:appId/secrets/:name',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const name = c.req.param('name')!;
    if (!SECRET_NAME_RE.test(name)) {
      throw new HttpError(400, 'name must be uppercase + underscores (e.g. OPENWEATHER_KEY)');
    }
    await requireOwner(c, appId);
    const kek = requireKek(c);

    const body = await c.req.json<{ value?: unknown }>().catch(() => ({}) as { value?: unknown });
    const value = body.value;
    if (typeof value !== 'string' || value.length === 0) {
      throw new HttpError(400, 'value must be a non-empty string');
    }
    if (value.length > 4096) {
      throw new HttpError(400, 'value too long (max 4096 chars)');
    }

    // Cap secrets per app — but allow updating an existing name without
    // bumping the count. SQLite has no upsert-with-count, so check first.
    const exists = await c.env.DB.prepare('SELECT 1 FROM app_secrets WHERE app_id = ? AND name = ?')
      .bind(appId, name)
      .first();
    if (!exists) {
      const countRow = await c.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM app_secrets WHERE app_id = ?',
      )
        .bind(appId)
        .first<{ n: number }>();
      if ((countRow?.n ?? 0) >= MAX_SECRETS_PER_APP) {
        throw new HttpError(
          409,
          `app has reached the free-tier limit of ${MAX_SECRETS_PER_APP} secrets`,
        );
      }
    }

    const sealed = await sealSecret(value, kek);
    await c.env.DB.prepare(
      `INSERT INTO app_secrets (app_id, name, key_ciphertext, dek_wrapped, iv, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(app_id, name) DO UPDATE SET
         key_ciphertext = excluded.key_ciphertext,
         dek_wrapped    = excluded.dek_wrapped,
         iv             = excluded.iv`,
    )
      .bind(appId, name, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, Date.now())
      .run();

    return c.body(null, 204);
  }),
);

secretsRoutes.delete(
  '/apps/:appId/secrets/:name',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const name = c.req.param('name')!;
    await requireOwner(c, appId);
    const result = await c.env.DB.prepare('DELETE FROM app_secrets WHERE app_id = ? AND name = ?')
      .bind(appId, name)
      .run();
    if (result.meta.changes === 0) throw new HttpError(404, 'secret not found');
    return c.body(null, 204);
  }),
);

// -----------------------------------------------------------------------------
// Allowlist CRUD
// -----------------------------------------------------------------------------

interface AllowlistRow {
  pattern: string;
  inject_kind: string;
  inject_name: string;
  secret_name: string;
  methods: string;
  created_at: number;
}

function rowToRule(r: AllowlistRow): AllowlistRule {
  return {
    pattern: r.pattern,
    injectKind: r.inject_kind as AllowlistRule['injectKind'],
    injectName: r.inject_name,
    secretName: r.secret_name,
    methods: r.methods.split(',').filter(Boolean),
  };
}

secretsRoutes.get(
  '/apps/:appId/allowlist',
  wrap(async (c) => {
    await requireOwner(c, c.req.param('appId')!);
    const result = await c.env.DB.prepare(
      `SELECT pattern, inject_kind, inject_name, secret_name, methods, created_at
       FROM app_proxy_allowlist WHERE app_id = ? ORDER BY pattern`,
    )
      .bind(c.req.param('appId')!)
      .all<AllowlistRow>();
    return c.json({
      rules: (result.results ?? []).map((r) => ({
        pattern: r.pattern,
        injectKind: r.inject_kind,
        injectName: r.inject_name,
        secretName: r.secret_name,
        methods: r.methods.split(',').filter(Boolean),
        createdAt: r.created_at,
      })),
    });
  }),
);

interface PutAllowlistBody {
  pattern?: unknown;
  injectKind?: unknown;
  injectName?: unknown;
  secretName?: unknown;
  methods?: unknown;
}

secretsRoutes.put(
  '/apps/:appId/allowlist',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireOwner(c, appId);
    const body = await c.req.json<PutAllowlistBody>().catch(() => ({}) as PutAllowlistBody);
    const rule = validateRule({
      pattern: String(body.pattern ?? ''),
      injectKind: String(body.injectKind ?? ''),
      injectName: String(body.injectName ?? ''),
      secretName: String(body.secretName ?? ''),
      methods: Array.isArray(body.methods) ? (body.methods as string[]) : [],
    });

    // Secret must exist before we let an allowlist rule reference it —
    // otherwise the proxy will silently 404 every call.
    const secretExists = await c.env.DB.prepare(
      'SELECT 1 FROM app_secrets WHERE app_id = ? AND name = ?',
    )
      .bind(appId, rule.secretName)
      .first();
    if (!secretExists) {
      throw new HttpError(400, `secret '${rule.secretName}' not found for this app`);
    }

    // Free cap on rule count (only when adding a new pattern).
    const exists = await c.env.DB.prepare(
      'SELECT 1 FROM app_proxy_allowlist WHERE app_id = ? AND pattern = ?',
    )
      .bind(appId, rule.pattern)
      .first();
    if (!exists) {
      const countRow = await c.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM app_proxy_allowlist WHERE app_id = ?',
      )
        .bind(appId)
        .first<{ n: number }>();
      if ((countRow?.n ?? 0) >= MAX_ALLOWLIST_PER_APP) {
        throw new HttpError(
          409,
          `app has reached the free-tier limit of ${MAX_ALLOWLIST_PER_APP} allowlist rules`,
        );
      }
    }

    await c.env.DB.prepare(
      `INSERT INTO app_proxy_allowlist
         (app_id, pattern, inject_kind, inject_name, secret_name, methods, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(app_id, pattern) DO UPDATE SET
         inject_kind = excluded.inject_kind,
         inject_name = excluded.inject_name,
         secret_name = excluded.secret_name,
         methods     = excluded.methods`,
    )
      .bind(
        appId,
        rule.pattern,
        rule.injectKind,
        rule.injectName,
        rule.secretName,
        rule.methods.join(','),
        Date.now(),
      )
      .run();

    return c.body(null, 204);
  }),
);

secretsRoutes.delete(
  '/apps/:appId/allowlist',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireOwner(c, appId);
    const body = await c.req
      .json<{ pattern?: unknown }>()
      .catch(() => ({}) as { pattern?: unknown });
    const pattern = String(body.pattern ?? '');
    if (!pattern) throw new HttpError(400, 'pattern is required');
    const result = await c.env.DB.prepare(
      'DELETE FROM app_proxy_allowlist WHERE app_id = ? AND pattern = ?',
    )
      .bind(appId, pattern)
      .run();
    if (result.meta.changes === 0) throw new HttpError(404, 'rule not found');
    return c.body(null, 204);
  }),
);

// -----------------------------------------------------------------------------
// The proxy itself
// -----------------------------------------------------------------------------

const PROXY_FORWARD_SKIP_HEADERS = new Set([
  // Strip auth + cookies — they were addressed to *us*, not the upstream,
  // and forwarding them would leak the user's platform session to a
  // third-party API the developer chose. We inject upstream auth via
  // the rule's inject_kind/inject_name.
  'authorization',
  'cookie',
  // Hop-by-hop headers per RFC 7230. The runtime sets these for us.
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Cloudflare-injected request headers — leaking client IP / geo to
  // arbitrary upstream APIs is also undesirable.
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-for',
  'x-real-ip',
]);

const PROXY_RESPONSE_SKIP_HEADERS = new Set([
  // Set-Cookie from upstream is meaningless to the browser (different origin)
  // and risks leaking upstream session state. Drop it.
  'set-cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  // The Workers runtime auto-decompresses gzip/br responses before
  // arrayBuffer() returns. If we passed the original content-encoding header
  // through, the browser would try to decode already-decoded bytes and get
  // garbage. content-length goes too — auto-decompression also changes it.
  'content-encoding',
  'content-length',
]);

// Map upstream hosts to user key vault provider IDs.
const HOST_TO_PROVIDER: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'openrouter.ai': 'openrouter',
  'api.openrouter.ai': 'openrouter',
  'generativelanguage.googleapis.com': 'google-ai',
  'api.replicate.com': 'replicate',
  'api.stability.ai': 'stability',
  'api.elevenlabs.io': 'elevenlabs',
  'api.stripe.com': 'stripe',
};

secretsRoutes.all('/apps/:appId/proxy/:host/*', async (c) => {
  try {
    // Auth: any valid platform session can call the proxy. The app's owner
    // pays the quota, not the caller. (See spec: free tier, per-app quota.)
    const user = await requireUser(c);
    const kek = requireKek(c);
    const appId = c.req.param('appId')!;
    const host = c.req.param('host')!;

    // Reconstruct upstream URL: /v1/apps/:appId/proxy/<host>/<rest...>
    const prefix = `/v1/apps/${appId}/proxy/${host}/`;
    if (!c.req.path.startsWith(prefix)) {
      return c.json({ error: 'malformed proxy path' }, 400);
    }
    const restPath = c.req.path.slice(prefix.length);
    const incomingUrl = new URL(c.req.url);
    const upstreamUrl = `https://${host}/${restPath}${incomingUrl.search}`;

    // Look up rules for the app, then pick the best match.
    const ruleRows = await c.env.DB.prepare(
      `SELECT pattern, inject_kind, inject_name, secret_name, methods, created_at
       FROM app_proxy_allowlist WHERE app_id = ?`,
    )
      .bind(appId)
      .all<AllowlistRow>();
    const rules = (ruleRows.results ?? []).map(rowToRule);
    const rule = pickRule(rules, upstreamUrl, c.req.method);

    // If no app-level rule matches, try the user's key vault.
    // This is the path for AI providers (OpenAI, Anthropic, etc.) where users
    // store their own keys on the platform.
    let plaintext: string;
    let injectedUrl: string;
    let injectedHeaders: Headers;

    if (!rule) {
      const provider = HOST_TO_PROVIDER[host.toLowerCase()];
      if (!provider) {
        return c.json({ error: `no allowlist match for ${c.req.method} ${upstreamUrl}` }, 403);
      }
      const userKey = await resolveUserKey(c.env.DB, (user as CurrentUser).id, provider, kek);
      if (!userKey) {
        return c.json(
          {
            error: `no_key`,
            provider,
            message: `You need to configure your ${provider} API key. Visit the platform key management page.`,
            manage_url: `/v1/keys?provider=${provider}&app=${appId}`,
          },
          403,
        );
      }
      plaintext = userKey;

      // User keys always inject as Bearer token.
      const forwardHeaders = new Headers();
      for (const [k, v] of c.req.raw.headers.entries()) {
        if (!PROXY_FORWARD_SKIP_HEADERS.has(k.toLowerCase())) {
          forwardHeaders.set(k, v);
        }
      }
      forwardHeaders.set('Authorization', `Bearer ${plaintext}`);
      injectedUrl = upstreamUrl;
      injectedHeaders = forwardHeaders;
    } else {
      // Daily cap (only for app-level secrets, not user keys).
      const usage = await checkAndBump(d1UsageStore(c.env.DB), {
        appId,
        dailyLimit: DAILY_PROXY_REQUESTS,
        nowMs: Date.now(),
      });
      if (!usage.allowed) {
        return c.json(
          { error: `app daily quota exceeded (${DAILY_PROXY_REQUESTS} requests/day)` },
          429,
        );
      }

      // Look up + decrypt the app secret.
      const secretRow = await c.env.DB.prepare(
        `SELECT key_ciphertext, dek_wrapped, iv FROM app_secrets
         WHERE app_id = ? AND name = ?`,
      )
        .bind(appId, rule.secretName)
        .first<{ key_ciphertext: unknown; dek_wrapped: unknown; iv: unknown }>();
      if (!secretRow) {
        return c.json({ error: `secret '${rule.secretName}' not found` }, 500);
      }
      const sealed: SealedSecret = {
        keyCiphertext: toUint8(secretRow.key_ciphertext),
        dekWrapped: toUint8(secretRow.dek_wrapped),
        iv: toUint8(secretRow.iv),
      };
      plaintext = await openSecret(sealed, kek);

      // Build forward request: filter inbound headers, then inject secret.
      const forwardHeaders = new Headers();
      for (const [k, v] of c.req.raw.headers.entries()) {
        if (!PROXY_FORWARD_SKIP_HEADERS.has(k.toLowerCase())) {
          forwardHeaders.set(k, v);
        }
      }
      const injected = injectSecret(rule, upstreamUrl, forwardHeaders, plaintext);
      injectedUrl = injected.url;
      injectedHeaders = injected.headers;
    }

    // Body: cap at 100 KB. Pull into memory once so we can both measure
    // and forward without re-streaming a hostile body.
    let forwardBody: BodyInit | null = null;
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const buf = await c.req.arrayBuffer();
      if (buf.byteLength > MAX_REQUEST_BODY_BYTES) {
        return c.json(
          { error: `request body too large (max ${MAX_REQUEST_BODY_BYTES} bytes)` },
          413,
        );
      }
      forwardBody = buf;
    }

    const upstreamRes = await fetch(injectedUrl, {
      method: c.req.method,
      headers: injectedHeaders,
      body: forwardBody,
    });

    // Cap response size by reading bytes ourselves; a streaming passthrough
    // would let a hostile upstream chew our CPU minutes.
    const respBuf = await upstreamRes.arrayBuffer();
    if (respBuf.byteLength > MAX_RESPONSE_BODY_BYTES) {
      return c.json({ error: 'upstream response too large' }, 502);
    }

    // Update last_used_at probabilistically (1 in 10) to save D1 writes.
    if (rule && Math.random() < 0.1) {
      const update = c.env.DB.prepare(
        'UPDATE app_secrets SET last_used_at = ? WHERE app_id = ? AND name = ?',
      )
        .bind(Date.now(), appId, rule.secretName)
        .run();
      try {
        c.executionCtx.waitUntil(update);
      } catch {
        update.catch(() => {});
      }
    }

    const respHeaders = new Headers();
    for (const [k, v] of upstreamRes.headers.entries()) {
      if (!PROXY_RESPONSE_SKIP_HEADERS.has(k.toLowerCase())) {
        // append, not set: preserves multi-value headers like Vary and Link.
        // entries() yields one entry per occurrence, so set() would only keep
        // the last.
        respHeaders.append(k, v);
      }
    }
    return new Response(respBuf, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    if (err instanceof AllowlistError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

function toUint8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array(0);
}
