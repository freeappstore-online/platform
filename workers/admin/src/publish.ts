// Publish API — creates everything needed to go from repo to live app.
// POST /api/provision
// Body: { id, name, category, icon, iconBg, description, store: "apps", type?: "standalone"|"connected" }
//
// History (per PLAN-ARCH-CLEANUP):
//   - "games" removed 2026-05-28 (Phase 3): use freegamestore-admin.
//   - "apps_pro" removed 2026-05-28 (Phase 4): use proappstore-admin /
//     pas/platform/packages/backend/src/routes/provision.ts (PAS provision
//     is fully self-contained).
//   - "games_pro" removed 2026-05-28 (Phase 5): use progamestore-admin.
//     The `pgs` CLI already hits admin.progamestore.online/v1/publish
//     directly — it never went through FAS admin.
//
// FAS admin now serves only the FreeAppStore.

import { APP_ID_RE } from "./transfer-owner";

export type Store = "apps";

export interface PublishEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  GITHUB_TOKEN: string;
  FAS_ZONE_ID: string;
  FGS_ZONE_ID: string;
  /** D1 binding for the `routes` table that freeappstore-host reads to map
   *  Host header → R2 prefix. */
  DB?: D1Database;
  /** Service binding to the FAS platform backend. The CF Web Analytics step
   *  needs it to persist the minted site_tag into `app_analytics`.
   *
   *  Required-but-nullable on purpose (`Fetcher | undefined`, not `?:`). The
   *  bug this fixes was a hand-built env literal in index.ts that simply left
   *  the key out, so every publish fell down the "no FAS backend binding —
   *  paste it manually" path and no app ever received a token. An optional
   *  field would have compiled just as silently; this forces every caller to
   *  name the key and decide. */
  BACKEND_FAS: Fetcher | undefined;
  /** Shared secret for admin→backend service-binding calls (X-Internal-Token).
   *  Required-but-nullable for the same reason as BACKEND_FAS. */
  ADMIN_PROVISION_TOKEN: string | undefined;
}

interface PublishRequest {
  id: string;
  name: string;
  category: string;
  icon: string;
  iconBg: string;
  description: string;
  store: Store;
  type?: string;
  creatorGithub?: string;
  /** GitHub repo the code lives in ('owner/name' or URL), if known. Persisted
   *  to the `apps.repo` column. */
  repo?: string | null;
  /** Live demo URL, if any. Persisted to the `apps.demo` column. */
  demo?: string | null;
  /** Pro-only: bullet list of features the pro subscription unlocks. */
  proFeatures?: string[];
  /**
   * Opt into cross-origin isolation (COOP/COEP) so SharedArrayBuffer and
   * threaded wasm work (#286). Omitted = leave the existing route value
   * unchanged on re-publish (new apps default off).
   */
  crossOriginIsolated?: boolean;
}

export interface Step {
  name: string;
  status: "ok" | "skip" | "fail";
  detail: string;
}

export interface StoreConfig {
  org: string;
  domain: string;
  storeRepo: string;
  registryPath: string;
  registryKey: string;
  developer: string;
  templateRepo: string;
  /** Resolves the CF zone id for DNS at request time. We can't put the id in
   * here statically because it lives in env vars. */
  zoneIdFromEnv: (env: PublishEnv) => string | undefined;
}

export const STORE_CONFIG: Record<Store, StoreConfig> = {
  apps: {
    org: "freeappstore-online",
    domain: "freeappstore.online",
    storeRepo: "platform",
    registryPath: "sites/storefront/registry.json",
    registryKey: "apps",
    developer: "FreeAppStore",
    templateRepo: "template-standalone",
    zoneIdFromEnv: (env) => env.FAS_ZONE_ID,
  },
};

const VALID_STORES: Store[] = ["apps"];

// GitHub returns 204 No Content for several success cases (e.g. PUT
// /collaborators when the user is already a collaborator). Plain res.json()
// throws SyntaxError on empty bodies, which then bubbles up as a generic
// 500 and is indistinguishable from a real provisioning failure. Parse the
// body as text first and only JSON.parse non-empty content.
//
// __status is always attached so callers can branch on HTTP status without
// inferring it from body shape (e.g. registry retry-on-409, collaborator 204).
async function parseJsonSafe(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return { __status: res.status, __empty: true };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Don't clobber a real "__status" field from the API (none exists today).
      if (parsed.__status === undefined) parsed.__status = res.status;
      return parsed;
    }
    return { __status: res.status, __body: parsed };
  } catch {
    return { __status: res.status, __raw: text };
  }
}

export async function cfApi(env: PublishEnv, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseJsonSafe(res);
}

/** Injectable GitHub API caller. Defaults to `ghApi` bound to env; tests can
 * supply a mock to exercise retry paths without hitting the network. */
export type GhFn = (path: string, method?: string, body?: unknown) => Promise<any>;

export async function ghApi(env: Pick<PublishEnv, "GITHUB_TOKEN">, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "freeappstore-admin",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseJsonSafe(res);
}

/**
 * Repos the platform itself lives in (#9). An app may never take one of these
 * names: the repo already exists, so publishing would skip creating it and
 * then grant the creator push access to platform code. Vendored in the
 * backend's lib/apps.ts (RESERVED_APP_IDS); keep the two in sync.
 */
const RESERVED_IDS = new Set(["platform", "admin", "agent", "mcp", "host", "console", "create", "publisher", "freeappstore"]);

export function isReservedId(id: string): boolean {
  const lower = id.toLowerCase();
  return RESERVED_IDS.has(lower) || lower.startsWith("template-");
}

function validateId(id: string): string | null {
  if (!id) return "ID is required";
  if (isReservedId(id)) return `"${id}" is reserved for the platform`;
  // The FreeAppStore id rule, shared with the backend, agent and transfer (#279).
  if (!APP_ID_RE.test(id))
    return "ID must be 2-31 characters: a lowercase letter first, a letter or number last, lowercase letters, numbers and dashes between.";
  if (id.startsWith("free") || id.startsWith("pro")) return "ID must not start with 'free' or 'pro'";
  return null;
}

/** `apps.owner_login` for an id, or null when there's no row or no DB to ask. */
async function recordedOwner(env: PublishEnv, id: string): Promise<string | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT owner_login FROM apps WHERE id = ?")
    .bind(id)
    .first<{ owner_login: string }>()
    .catch(() => null);
  return row?.owner_login ?? null;
}

/** Build the registry entry that ships into the storefront's registry.json. */
function buildRegistryEntry(req: PublishRequest, config: StoreConfig, subdomain: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: req.id,
    name: req.name,
    category: req.category,
    icon: req.icon,
    iconBg: req.iconBg,
    description: req.description,
    appUrl: `https://${subdomain}`,
    repo: `${config.org}/${req.id}`,
    hostedOn: "r2",
    type: req.type || "standalone",
    developer: config.developer,
    discoveryStatus: "pending",
    discoveryRequestedAt: new Date().toISOString(),
  };
  // Persist the creator's GitHub username so the storefront can render
  // author chips + per-author profile pages at /u/<username>. The admin
  // worker already collects creatorGithub to grant repo push access;
  // capturing it in the registry too removes the need for a separate
  // creator-lookup table for the public storefront.
  if (req.creatorGithub) {
    entry.creatorGithub = req.creatorGithub;
  }
  if (req.crossOriginIsolated === true) {
    entry.crossOriginIsolated = true;
  }
  return entry;
}

export function decodeRegistry(file: { content: string }): any {
  const rawContent = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  return JSON.parse(rawContent);
}

export function encodeRegistry(content: unknown): string {
  return btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(content, null, 2)))
      .map((b) => String.fromCharCode(b))
      .join(""),
  );
}

/** Write the new entry to the storefront's registry.json with retry-once-on-409.
 *
 * Why retry: two concurrent provisions (e.g. one via the admin UI, one via PAS
 * service binding) both GET the file, both PUT with the same sha — GitHub rejects
 * the second PUT with 409. Retry once: re-GET (fresh sha), re-check alreadyListed
 * against the new content (the other writer may have already added our entry),
 * then re-PUT. If still 409 on attempt 2, ask the user to retry the provision —
 * three concurrent provisions of the same id is vanishingly rare and a real
 * fix would need GH branch-protection or a CRDT, both overkill for our volume. */
export async function writeRegistryWithRetry(gh: GhFn, req: PublishRequest, config: StoreConfig, subdomain: string): Promise<Step> {
  const registryPath = `/repos/${config.org}/${config.storeRepo}/contents/${config.registryPath}`;
  const key = config.registryKey;
  const entry = buildRegistryEntry(req, config, subdomain);

  // Single attempt. Returns either a finished Step (success/skip), or `null`
  // to signal "409 — caller should retry once".
  const attempt = async (isRetry: boolean): Promise<Step | null> => {
    const registryFile = await gh(registryPath);
    if (!registryFile.content) {
      return { name: "Store registry", status: "fail", detail: "Could not read registry.json" };
    }
    const content = decodeRegistry(registryFile);
    const items = content[key] || [];
    const existing = items.find((a: any) => a.id === req.id);
    if (existing) {
      return {
        name: "Store registry",
        status: "skip",
        detail:
          existing.discoveryStatus === "pending"
            ? "Provisioned; awaiting a successful deployment before listing"
            : isRetry
              ? "Added by a concurrent provision"
              : "Already provisioned; existing publication settings preserved",
      };
    }
    items.push(entry);
    content[key] = items;

    const updateResult = await gh(registryPath, "PUT", {
      message: `Add ${req.name} to ${req.store} registry`,
      content: encodeRegistry(content),
      sha: registryFile.sha,
    });
    if (updateResult.content) {
      return { name: "Store registry", status: "ok", detail: `Provisioned ${req.name}; awaiting a successful deployment before listing` };
    }
    if (updateResult.__status === 409) {
      return null; // caller decides whether to retry
    }
    return {
      name: "Store registry",
      status: "fail",
      detail: updateResult.message || "Failed to update",
    };
  };

  const first = await attempt(false);
  if (first !== null) return first;

  const second = await attempt(true);
  if (second !== null) return second;

  return {
    name: "Store registry",
    status: "fail",
    detail: "Registry write contended twice — please retry the provision",
  };
}

/** Write the two D1 rows that make an app real: the `routes` row
 *  freeappstore-host reads to map the subdomain → R2 prefix, AND the `apps`
 *  ownership/metadata row every per-app backend feature (kv, rooms, counters,
 *  db, email, secrets, webhooks, roles) gates on.
 *
 *  Both are written in a single `env.DB.batch([...])` transaction so a
 *  provision can never land in one table but not the other. That split was the
 *  root cause of the drift class that orphaned 21 early apps: they were created
 *  in registry.json + `routes` by the admin worker, but the `apps` INSERT lived
 *  in the backend wrapper as a best-effort try/catch — when it silently failed
 *  (or the caller skipped the backend path), the app existed everywhere except
 *  `apps`, so `appExists()`/owner_login checks 403'd every backend feature.
 *  Unifying the write here makes every provision path write identical state.
 *
 *  Idempotent: `routes` upserts via ON CONFLICT DO UPDATE (re-publish just
 *  bumps updated_at); `apps` uses INSERT OR IGNORE so a re-publish never
 *  clobbers an existing owner. The r2_prefix follows `{registryKey}/{id}`
 *  (e.g. `apps/kanban`) — the path the per-app deploy.yml uploads to. */
/** The apps row that records an app's owner. INSERT OR IGNORE: the first claim wins. */
function claimAppStmt(db: D1Database, req: PublishRequest, ownerLogin: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO apps
         (id, owner_login, created_at, category, type, oneliner, repo, demo, store)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      req.id,
      ownerLogin,
      now,
      req.category ?? null,
      req.type || "standalone",
      req.description ?? null,
      req.repo ?? null,
      req.demo ?? null,
      req.store,
    );
}

export async function insertHostRoute(env: PublishEnv, req: PublishRequest, config: StoreConfig): Promise<Step> {
  const slug = req.id;
  const zone = config.domain;
  const r2Prefix = `${config.registryKey}/${req.id}`;
  const now = Date.now();
  if (!env.DB) {
    return { name: "Hosting route", status: "fail", detail: "D1 binding not available (cross-store service binding?)" };
  }
  // owner_login is NOT NULL. The backend always resolves + sends creatorGithub;
  // a direct admin-UI provision may omit it, in which case the org owns the app
  // until it's explicitly reassigned.
  const ownerLogin = req.creatorGithub || config.org;
  try {
    const isolated = req.crossOriginIsolated === true ? 1 : 0;
    const updateIsolated = typeof req.crossOriginIsolated === "boolean" ? 1 : 0;
    const routesStmt = env.DB.prepare(
      `INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at, cross_origin_isolated)
         VALUES (?1, ?2, ?3, ?4, 'r2', ?5, ?5, ?6)
         ON CONFLICT (slug, zone) DO UPDATE SET
           r2_prefix = excluded.r2_prefix,
           store = excluded.store,
           hosted_on = excluded.hosted_on,
           updated_at = excluded.updated_at,
           cross_origin_isolated = CASE WHEN ?7 = 1 THEN excluded.cross_origin_isolated ELSE routes.cross_origin_isolated END`,
    ).bind(slug, zone, r2Prefix, req.store, now, isolated, updateIsolated);
    await env.DB.batch([routesStmt, claimAppStmt(env.DB, req, ownerLogin, now)]);
    return { name: "Hosting route", status: "ok", detail: `${slug}.${zone} → r2://fas-apps/${r2Prefix} (owner ${ownerLogin})` };
  } catch (e: any) {
    return { name: "Hosting route", status: "fail", detail: e?.message ?? "D1 write failed" };
  }
}

/**
 * The app's repo. Creates an EMPTY one for a new app; an existing repo is
 * only re-published by the app's recorded owner (#9) — anything else (someone
 * else's app, or a repo with no ownership row) fails here, before the
 * collaborator grant.
 */
async function ensureRepo(req: PublishRequest, config: StoreConfig, env: PublishEnv, ghCall: GhFn): Promise<Step> {
  // Why not "generate from template"? The template has APPNAME placeholders
  // that need substituting per app. Server-side substitution would mean
  // reading every file in the generated repo, replacing, and committing
  // back — fragile (binary files, encoding) and doubles the GH API calls.
  // Instead: the user's local `fas init` already substitutes correctly, so
  // we create an empty repo here and let `git push` make their substituted
  // local code the canonical source from the very first commit.
  //
  // auto_init: false — no initial README. GitHub Actions deploy won't run
  // until the user pushes their first commit, which is exactly what we tell
  // them to do in the fas publish "Push your code:" instructions.
  // The apps row can exist before the repo does (the VibeCode agent claims the
  // id first), so check the recorded owner whether or not the repo exists.
  const owner = await recordedOwner(env, req.id);
  const publisher = req.creatorGithub || config.org;
  const isOwner = !!owner && owner.toLowerCase() === publisher.toLowerCase();
  if (owner && !isOwner) {
    return { name: "GitHub repo", status: "fail", detail: `${req.id} is already claimed and isn't yours to publish` };
  }
  const repoCheck = await ghCall(`/repos/${config.org}/${req.id}`);
  if (repoCheck.id) {
    if (!isOwner) {
      return { name: "GitHub repo", status: "fail", detail: `${config.org}/${req.id} already exists and isn't yours to publish` };
    }
    return { name: "GitHub repo", status: "skip", detail: `${config.org}/${req.id} already exists` };
  }
  // Claim the id before creating anything (#279). The repo used to be created
  // first and the apps row written in a later step, so a failure in between
  // left a repo with no recorded owner, which every retry then refused. With
  // the row written first, a retry finds its own claim and resumes.
  if (!owner) {
    if (!env.DB) return { name: "GitHub repo", status: "fail", detail: "D1 binding not available; can't record the owner" };
    await claimAppStmt(env.DB, req, publisher, Date.now()).run();
    const claimed = await recordedOwner(env, req.id);
    if (!claimed || claimed.toLowerCase() !== publisher.toLowerCase()) {
      return { name: "GitHub repo", status: "fail", detail: `${req.id} is already claimed and isn't yours to publish` };
    }
  }
  const createRepo = await ghCall(`/orgs/${config.org}/repos`, "POST", {
    name: req.id,
    private: false,
    description: req.description,
    auto_init: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  });
  if (createRepo.id) {
    return { name: "GitHub repo", status: "ok", detail: `Created empty ${config.org}/${req.id} (push your local code to populate)` };
  }
  return { name: "GitHub repo", status: "fail", detail: createRepo.message || "Failed to create repo" };
}

export async function handlePublish(req: PublishRequest, env: PublishEnv, gh?: GhFn): Promise<{ steps: Step[]; success: boolean }> {
  const steps: Step[] = [];
  const ghCall: GhFn = gh ?? ((path, method, body) => ghApi(env, path, method, body));

  // Validate inputs
  if (!req.id || !req.name || !req.store) {
    return { steps: [{ name: "Validation", status: "fail", detail: "id, name, and store are required" }], success: false };
  }
  if (!VALID_STORES.includes(req.store)) {
    return {
      steps: [{ name: "Validation", status: "fail", detail: `store must be one of: ${VALID_STORES.join(", ")}` }],
      success: false,
    };
  }
  const idError = validateId(req.id);
  if (idError) {
    return { steps: [{ name: "Validation", status: "fail", detail: idError }], success: false };
  }

  const config = STORE_CONFIG[req.store];
  const subdomain = `${req.id}.${config.domain}`;

  // Step 1: an empty repo for a new app, or the publisher's own existing one.
  const repoStep = await ensureRepo(req, config, env, ghCall);
  steps.push(repoStep);
  if (repoStep.status === "fail") return { steps, success: false };

  // Step 1b: Add creator as collaborator with push access
  if (req.creatorGithub) {
    const collab = await ghCall(`/repos/${config.org}/${req.id}/collaborators/${req.creatorGithub}`, "PUT", { permission: "push" });
    if (collab.id || collab.invitee) {
      // Outside collaborators (creator not in the org) get a PENDING invite they
      // must accept before they can push — and it expires in ~7 days. Tell them.
      steps.push({
        name: "Collaborator",
        status: "ok",
        detail: `${req.creatorGithub} invited as push collaborator — accept the GitHub invite at https://github.com/${config.org}/${req.id}/invitations (check email/notifications) before pushing`,
      });
    } else if (collab.__empty && collab.__status === 204) {
      // GitHub returns 204 No Content when the user already has the requested
      // permission (e.g. org owners are implicit admins on every repo).
      steps.push({ name: "Collaborator", status: "skip", detail: `${req.creatorGithub} already has push access` });
    } else if (collab.message?.includes("already")) {
      steps.push({ name: "Collaborator", status: "skip", detail: `${req.creatorGithub} already has access` });
    } else {
      steps.push({
        name: "Collaborator",
        status: "fail",
        detail: collab.message || `Failed to add collaborator (status ${collab.__status ?? "?"})`,
      });
    }
  }

  // Step 2: Hosting route — insert into D1 so the host worker serves
  // this app's static files from R2.
  const hostingStep = await insertHostRoute(env, req, config);
  steps.push(hostingStep);

  // Step 3: Add to store registry — but ONLY if the hosting route insert
  // succeeded. Without this guard a failed insert would still ship a
  // dead-link card in the storefront until someone notices and prunes it.
  if (hostingStep.status === "fail") {
    steps.push({
      name: "Store registry",
      status: "skip",
      detail: "Skipped: hosting route insert failed. Fix the failing step and retry to add the entry.",
    });
    return { steps, success: false };
  }
  const registryStep = await writeRegistryWithRetry(ghCall, req, config, subdomain);
  steps.push(registryStep);

  // Step 6: CF Web Analytics — mint a site_token for this app's subdomain.
  // Non-fatal: a failure here doesn't break provisioning, since the app's
  // <script src=".../v1/analytics.js?app=ID"> loader will gracefully no-op
  // until a token is wired in (creator can also set BYO GA4/Plausible without
  // a CF token). The token is also written to the right backend Worker's
  // app_analytics table — FAS backend for free apps/games, PAS backend for
  // pro apps — via per-store service binding when available.
  const analyticsStep = await provisionCfWebAnalytics(env, req, config, subdomain);
  steps.push(analyticsStep);

  const success = steps.every((s) => s.status !== "fail");
  return { steps, success };
}

/**
 * Create (or look up) a CF Web Analytics RUM site for this app's subdomain
 * and persist the minted site_tag to the right backend's `app_analytics`
 * row (FAS backend for free apps + games, PAS backend for pro apps).
 *
 * Idempotent on both sides — CF list-then-create avoids duplicate sites;
 * the backend's INSERT ... ON CONFLICT keeps repeat provisions safe.
 *
 * Non-fatal if the backend service binding for the target store is missing —
 * we return the freshly-minted site_tag in the step detail so the operator
 * can paste it via the owner-protected PUT endpoint manually.
 */
async function provisionCfWebAnalytics(env: PublishEnv, req: PublishRequest, config: StoreConfig, subdomain: string): Promise<Step> {
  try {
    // Look up or create the RUM site for this host.
    const existing = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/rum/site_info/list`);
    let siteTag: string | undefined;
    let created = false;
    if (existing?.success && Array.isArray(existing.result)) {
      const match = existing.result.find(
        (s: { ruleset?: { zone_tag?: string }; host?: string; site_tag?: string }) => s.host === subdomain,
      );
      if (match?.site_tag) siteTag = match.site_tag;
    }
    if (!siteTag) {
      const zone = config.zoneIdFromEnv(env) || "";
      const created_res = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/rum/site_info`, "POST", {
        host: subdomain,
        zone_tag: zone,
        auto_install: false,
      });
      if (!created_res?.success) {
        const detail = created_res?.errors?.[0]?.message || "CF rum/site_info POST failed";
        return { name: "CF Web Analytics", status: "skip", detail: `(non-fatal) ${detail}` };
      }
      siteTag = created_res.result?.site_tag;
      created = true;
    }
    if (!siteTag) {
      return { name: "CF Web Analytics", status: "skip", detail: "(non-fatal) no site_tag returned" };
    }
    // FAS admin only serves "apps" — analytics rows live in the FAS backend D1.
    const targetBackend = env.BACKEND_FAS;
    const targetName = "FAS backend";
    if (targetBackend && env.ADMIN_PROVISION_TOKEN) {
      const persistRes = await targetBackend.fetch(`https://backend/v1/internal/apps/${encodeURIComponent(req.id)}/analytics/cf-token`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": env.ADMIN_PROVISION_TOKEN,
        },
        body: JSON.stringify({ cf_beacon_token: siteTag }),
      });
      if (!persistRes.ok) {
        const body = await persistRes.text().catch(() => "");
        return {
          name: "CF Web Analytics",
          status: "skip",
          detail: `(non-fatal) minted site_tag=${siteTag} but ${targetName} persist failed (${persistRes.status}): ${body.slice(0, 200)}`,
        };
      }
      return {
        name: "CF Web Analytics",
        status: created ? "ok" : "skip",
        detail: created
          ? `Minted RUM site for ${subdomain}, persisted to ${targetName}`
          : `RUM site already exists for ${subdomain}, refreshed in ${targetName}`,
      };
    }
    return {
      name: "CF Web Analytics",
      status: created ? "ok" : "skip",
      detail: created
        ? `Minted site_tag=${siteTag} for ${subdomain} (no ${targetName} binding — paste it manually)`
        : `RUM site already exists for ${subdomain} (no ${targetName} binding — paste site_tag=${siteTag} manually)`,
    };
  } catch (err) {
    return {
      name: "CF Web Analytics",
      status: "skip",
      detail: `(non-fatal) ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
