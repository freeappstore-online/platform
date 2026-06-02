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

export type Store = "apps";

interface PublishEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  GITHUB_TOKEN: string;
  FAS_ZONE_ID: string;
  FGS_ZONE_ID: string;
  /** D1 binding for the `routes` table that freeappstore-host reads to map
   *  Host header → R2 prefix. */
  DB?: D1Database;
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
  /** Pro-only: bullet list of features the pro subscription unlocks. */
  proFeatures?: string[];
}

interface Step {
  name: string;
  status: "ok" | "skip" | "fail";
  detail: string;
}

interface StoreConfig {
  org: string;
  domain: string;
  storeRepo: string;
  registryKey: string;
  developer: string;
  templateRepo: string;
  /** Resolves the CF zone id for DNS at request time. We can't put the id in
   * here statically because it lives in env vars. */
  zoneIdFromEnv: (env: PublishEnv) => string | undefined;
}

const STORE_CONFIG: Record<Store, StoreConfig> = {
  apps: {
    org: "freeappstore-online",
    domain: "freeappstore.online",
    storeRepo: "freeappstore",
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

async function cfApi(env: PublishEnv, path: string, method = "GET", body?: any) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseJsonSafe(res);
}

/** Injectable GitHub API caller. Defaults to `ghApi` bound to env; tests can
 * supply a mock to exercise retry paths without hitting the network. */
export type GhFn = (path: string, method?: string, body?: any) => Promise<any>;

async function ghApi(env: PublishEnv, path: string, method = "GET", body?: any) {
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

function validateId(id: string): string | null {
  if (!id) return "ID is required";
  if (id.length > 58) return "ID must be 58 characters or less";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id))
    return "ID must be lowercase letters, numbers, and dashes only. Cannot start/end with a dash.";
  if (id.startsWith("free") || id.startsWith("pro")) return "ID must not start with 'free' or 'pro'";
  return null;
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
  };
  // Persist the creator's GitHub username so the storefront can render
  // author chips + per-author profile pages at /u/<username>. The admin
  // worker already collects creatorGithub to grant repo push access;
  // capturing it in the registry too removes the need for a separate
  // creator-lookup table for the public storefront.
  if (req.creatorGithub) {
    entry.creatorGithub = req.creatorGithub;
  }
  return entry;
}

function decodeRegistry(file: any): any {
  const rawContent = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  return JSON.parse(rawContent);
}

function encodeRegistry(content: any): string {
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
  const registryPath = `/repos/${config.org}/${config.storeRepo}/contents/registry.json`;
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
    const alreadyListed = items.some((a: any) => a.id === req.id);
    if (alreadyListed) {
      return {
        name: "Store registry",
        status: "skip",
        detail: isRetry ? "Added by a concurrent provision" : "Already listed",
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
      return { name: "Store registry", status: "ok", detail: `Added ${req.name}` };
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

/** Insert (or upsert) the routes-table row that freeappstore-host reads
 *  to map this app's subdomain to its R2 prefix.
 *
 *  Idempotent via ON CONFLICT DO UPDATE — re-publishing the same id is a
 *  no-op for routing, just bumps updated_at. The r2_prefix follows the
 *  convention `{registryKey}/{id}` (e.g. `apps/kanban`, `games/chess`)
 *  which matches the path the per-app `.github/workflows/deploy.yml`
 *  uploads to in the fas-apps bucket. */
export async function insertHostRoute(env: PublishEnv, req: PublishRequest, config: StoreConfig): Promise<Step> {
  const slug = req.id;
  const zone = config.domain;
  const r2Prefix = `${config.registryKey}/${req.id}`;
  const now = Date.now();
  if (!env.DB) {
    return { name: "Hosting route", status: "fail", detail: "D1 binding not available (cross-store service binding?)" };
  }
  try {
    await env.DB.prepare(
      `INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'r2', ?5, ?5)
         ON CONFLICT (slug, zone) DO UPDATE SET
           r2_prefix = excluded.r2_prefix,
           store = excluded.store,
           hosted_on = excluded.hosted_on,
           updated_at = excluded.updated_at`,
    )
      .bind(slug, zone, r2Prefix, req.store, now)
      .run();
    return { name: "Hosting route", status: "ok", detail: `${slug}.${zone} → r2://fas-apps/${r2Prefix}` };
  } catch (e: any) {
    return { name: "Hosting route", status: "fail", detail: e?.message ?? "D1 insert failed" };
  }
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

  // Step 1: Create an EMPTY GitHub repo in the org.
  //
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
  const repoCheck = await ghCall(`/repos/${config.org}/${req.id}`);
  if (repoCheck.id) {
    steps.push({ name: "GitHub repo", status: "skip", detail: `${config.org}/${req.id} already exists` });
  } else {
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
      steps.push({
        name: "GitHub repo",
        status: "ok",
        detail: `Created empty ${config.org}/${req.id} (push your local code to populate)`,
      });
    } else {
      steps.push({ name: "GitHub repo", status: "fail", detail: createRepo.message || "Failed to create repo" });
      return { steps, success: false };
    }
  }

  // Step 1b: Add creator as collaborator with push access
  if (req.creatorGithub) {
    const collab = await ghCall(`/repos/${config.org}/${req.id}/collaborators/${req.creatorGithub}`, "PUT", { permission: "push" });
    if (collab.id || collab.invitee) {
      steps.push({ name: "Collaborator", status: "ok", detail: `${req.creatorGithub} granted push access` });
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
async function provisionCfWebAnalytics(
  env: PublishEnv & {
    BACKEND_FAS?: Fetcher;
    INTERNAL_TOKEN?: string;
  },
  req: PublishRequest,
  config: StoreConfig,
  subdomain: string,
): Promise<Step> {
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
    if (targetBackend && env.INTERNAL_TOKEN) {
      const persistRes = await targetBackend.fetch(`https://backend/v1/internal/apps/${encodeURIComponent(req.id)}/analytics/cf-token`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": env.INTERNAL_TOKEN,
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

export function renderProvisionForm(): string {
  return `
  <h2 style="margin-top:3rem;">Provision New App / Game</h2>
  <form id="provisionForm" style="max-width:500px;margin-top:1rem;">
    <div style="display:grid;gap:0.75rem;">
      <select name="store" style="padding:0.5rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.5rem;color:#e5e5e5;">
        <option value="apps">App (freeappstore.online)</option>
      </select>
      <!-- Game provisioning moved to admin.freegamestore.online — separate per-store admin Worker. -->
      <!-- Pro provisioning lives on admin.proappstore.online / admin.progamestore.online. -->
      <input name="id" placeholder="ID (e.g. calendar)" required style="padding:0.5rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.5rem;color:#e5e5e5;" />
      <input name="name" placeholder="Display name (e.g. Calendar)" required style="padding:0.5rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.5rem;color:#e5e5e5;" />
      <input name="category" placeholder="Category (e.g. utilities)" required style="padding:0.5rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.5rem;color:#e5e5e5;" />
      <input name="icon" placeholder="Icon HTML entity (e.g. &#128197;)" required style="padding:0.5rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.5rem;color:#e5e5e5;" />
      <input name="iconBg" placeholder="Icon bg color (e.g. #f0fdf4)" value="#f0f9ff" style="padding:0.5rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.5rem;color:#e5e5e5;" />
      <input name="description" placeholder="Short description" required style="padding:0.5rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.5rem;color:#e5e5e5;" />
      <input name="creatorGithub" placeholder="Creator GitHub username (gets push access)" style="padding:0.5rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.5rem;color:#e5e5e5;" />
      <button type="submit" style="padding:0.6rem;background:#2563eb;color:white;border:none;border-radius:0.5rem;cursor:pointer;font-weight:600;">Publish</button>
    </div>
  </form>
  <div id="provisionResult" style="margin-top:1rem;font-family:monospace;font-size:0.85rem;"></div>
  <script>
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    document.getElementById('provisionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const body = Object.fromEntries(form);
      const el = document.getElementById('provisionResult');
      el.innerHTML = '<span style="color:#fbbf24">Provisioning...</span>';
      try {
        const res = await fetch('/api/provision', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const data = await res.json();
        el.innerHTML = data.steps.map(s =>
          '<div style="margin:0.25rem 0">' +
          (s.status === 'ok' ? '🟢' : s.status === 'skip' ? '🟡' : '🔴') +
          ' <strong>' + esc(s.name) + '</strong>: ' + esc(s.detail) + '</div>'
        ).join('') + '<div style="margin-top:0.75rem;font-weight:700;color:' + (data.success ? '#34d399' : '#f87171') + '">' +
          (data.success ? 'Provisioned successfully!' : 'Some steps failed.') + '</div>';
      } catch(err) {
        el.innerHTML = '<span style="color:#f87171">Error: ' + esc(err) + '</span>';
      }
    });
  </script>

  <h2 style="margin-top:3rem;">API Reference</h2>
  <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:0.75rem;padding:1.5rem;margin-top:1rem;font-family:monospace;font-size:0.85rem;">
    <p style="margin-bottom:0.5rem;"><strong>POST /api/provision</strong></p>
    <p style="color:#888;margin-bottom:1rem;">Creates repo, hosting route, and registry entry.</p>
    <pre style="color:#e5e5e5;white-space:pre-wrap;">{
  "id": "calendar",
  "name": "Calendar",
  "category": "utilities",
  "icon": "&amp;#128197;",
  "iconBg": "#f0fdf4",
  "description": "Simple calendar app",
  "store": "apps"
}</pre>
    <p style="margin-top:1rem;color:#888;">Auth: Cloudflare Access (Google sign-in). No API tokens needed.</p>
    <p style="margin-top:0.5rem;color:#888;">For AI agents: <code>curl -X POST https://admin.freeappstore.online/api/provision -H 'Content-Type: application/json' -d '{...}'</code></p>
    <p style="margin-top:0.5rem;color:#f87171;">Note: API is behind Cloudflare Access. AI agents cannot call it directly — use the admin UI or the publish.sh script locally.</p>
  </div>`;
}
