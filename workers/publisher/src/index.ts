interface Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  CF_GLOBAL_KEY: string;
  CF_EMAIL: string;
  GITHUB_TOKEN: string;
  MAX_APPS_PER_USER: string;
  CREATORS: KVNamespace;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  FAS_ZONE_ID: string;
  FGS_ZONE_ID: string;
}

interface CreatorRecord {
  github: string;
  apps: { id: string; store: string; name: string; createdAt: string }[];
  banned: boolean;
  maxApps: number;
}

// FAS publisher now only handles `apps`. The `games` branch was removed
// 2026-05-28 (PLAN-ARCH-CLEANUP follow-up): FGS publishes have their own
// per-store admin Worker at admin.freegamestore.online. Routing FGS
// through this publisher would (a) bypass FGS admin's auth + KV
// ownership tracking, and (b) burn the 100-projects/account CF Pages
// cap that FAS already squeezed via Path B. Keep this dict apps-only.
const STORE_CONFIG: Record<
  string,
  { org: string; domain: string; storeRepo: string; registryKey: string; developer: string; templateRepo: string }
> = {
  apps: {
    org: "freeappstore-online",
    domain: "freeappstore.online",
    storeRepo: "freeappstore",
    registryKey: "apps",
    developer: "FreeAppStore",
    templateRepo: "template-standalone",
  },
};

function getZoneId(env: Env, _store: string): string {
  return env.FAS_ZONE_ID;
}

function validateId(id: string): string | null {
  if (!id) return "ID is required";
  if (id.length > 58) return "ID must be 58 characters or less";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id)) return "Lowercase letters, numbers, dashes only. No start/end dash.";
  if (id.startsWith("free") || id.startsWith("pro")) return "Cannot start with 'free' or 'pro'";
  return null;
}

// ── C-2: CF Access JWT verification ──

function base64UrlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

let cachedCerts: { keys: JsonWebKey[]; at: number } | null = null;

async function fetchAccessCerts(teamDomain: string): Promise<JsonWebKey[]> {
  if (cachedCerts && Date.now() - cachedCerts.at < 3600_000) return cachedCerts.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Failed to fetch CF Access certs");
  const data = (await res.json()) as { keys: JsonWebKey[] };
  cachedCerts = { keys: data.keys, at: Date.now() };
  return data.keys;
}

async function verifyAccessJwt(jwt: string, teamDomain: string, aud: string): Promise<string | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]!)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!)));
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    if (Array.isArray(payload.aud)) {
      if (!payload.aud.includes(aud)) return null;
    } else if (payload.aud && payload.aud !== aud) {
      return null;
    }
    const keys = await fetchAccessCerts(teamDomain);
    const key = keys.find((k: any) => k.kid === header.kid);
    if (!key) return null;
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = base64UrlDecode(parts[2]!);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, data);
    if (!valid) return null;
    const email = payload.email || "";
    if (email.includes("@")) return email.split("@")[0]!;
    return email || payload.sub || null;
  } catch {
    return null;
  }
}

async function getGitHubUser(request: Request, env: Env): Promise<string | null> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    // CF_ACCESS_AUD must be configured — reject if missing (no unverified fallback)
    return null;
  }
  const user = await verifyAccessJwt(jwt, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
  if (!user) return null;
  // Validate username format (GitHub usernames: alphanumeric + hyphens, 1-39 chars)
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(user) || user.length > 39) {
    return null;
  }
  return user;
}

// ── H-3: Rate limiting ──

async function checkRateLimit(kv: KVNamespace, user: string, action: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${user}:${action}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw) : 0;
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

// ── Audit ──

/** Live audit: fetch the deployed app and check basic compliance. */
async function auditLive(
  appUrl: string,
): Promise<{ pass: number; fail: number; checks: { name: string; status: string; detail?: string }[] }> {
  const checks: { name: string; status: string; detail?: string }[] = [];
  try {
    const res = await fetch(appUrl, { headers: { "User-Agent": "freeappstore-auditor" }, redirect: "follow" });
    if (!res.ok) {
      checks.push({ name: "Reachable", status: "fail", detail: `HTTP ${res.status}` });
      return { pass: 0, fail: 1, checks };
    }
    const html = await res.text();
    checks.push({ name: "Reachable", status: "pass" });

    // Viewport meta
    checks.push(
      /viewport/.test(html)
        ? { name: "Viewport", status: "pass" }
        : { name: "Viewport", status: "fail", detail: "Missing viewport meta tag" },
    );

    // Title
    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    checks.push(
      titleMatch && titleMatch[1].length > 0
        ? { name: "Title", status: "pass" }
        : { name: "Title", status: "fail", detail: "Missing or empty <title>" },
    );

    // Manifest
    checks.push(
      /manifest/.test(html) ? { name: "Manifest", status: "pass" } : { name: "Manifest", status: "warn", detail: "No manifest link found" },
    );

    // Brand fonts (Manrope or Fraunces)
    checks.push(
      /manrope|fraunces/i.test(html)
        ? { name: "Brand fonts", status: "pass" }
        : { name: "Brand fonts", status: "warn", detail: "No Manrope/Fraunces font reference" },
    );

    // Store link
    checks.push(
      /freeappstore\.online|freegamestore\.online/.test(html)
        ? { name: "Store link", status: "pass" }
        : { name: "Store link", status: "warn", detail: "No store link found in HTML" },
    );

    // No tracking
    const tracking = /google-analytics|gtag\(|amplitude|mixpanel|segment\.com|hotjar/i.test(html);
    checks.push(
      !tracking ? { name: "No tracking", status: "pass" } : { name: "No tracking", status: "fail", detail: "Tracking script detected" },
    );
  } catch (err) {
    checks.push({ name: "Reachable", status: "fail", detail: "Could not reach the deployed app" });
  }
  return {
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    checks,
  };
}

// ── Creator KV ──

async function getCreator(env: Env, github: string): Promise<CreatorRecord> {
  const raw = await env.CREATORS.get(github);
  if (raw) return JSON.parse(raw);
  return { github, apps: [], banned: false, maxApps: parseInt(env.MAX_APPS_PER_USER || "5") };
}

async function saveCreator(env: Env, record: CreatorRecord) {
  await env.CREATORS.put(record.github, JSON.stringify(record));
}

// ── Provision ──

async function provision(
  env: Env,
  id: string,
  name: string,
  category: string,
  icon: string,
  iconBg: string,
  description: string,
  store: string,
  creator: string,
) {
  const config = STORE_CONFIG[store]!;
  const cfProject = `free${id}app`;
  const subdomain = `${id}.${config.domain}`;
  const steps: { name: string; status: string; detail: string }[] = [];

  // Create GitHub repo from template
  const repoCheck = await fetch(`https://api.github.com/repos/${config.org}/${id}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "freeappstore-publisher" },
  });
  if (((await repoCheck.json()) as any).id) {
    steps.push({ name: "GitHub repo", status: "skip", detail: "Already exists" });
  } else {
    const createRes = await fetch(`https://api.github.com/repos/${config.org}/${config.templateRepo}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "freeappstore-publisher",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ owner: config.org, name: id, private: false, description }),
    });
    const createData = (await createRes.json()) as any;
    steps.push({
      name: "GitHub repo",
      status: createData.id ? "ok" : "fail",
      detail: createData.id ? `${config.org}/${id}` : createData.message || "Failed",
    });
    if (!createData.id) return { steps, success: false };
  }

  // CF Pages project
  const projRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: cfProject,
      source: {
        type: "github",
        config: {
          owner: config.org,
          repo_name: id,
          production_branch: "main",
          deployments_enabled: true,
          production_deployments_enabled: true,
        },
      },
      build_config: { build_command: "npx pnpm@10 install && npx pnpm@10 build", destination_dir: "web/dist" },
      deployment_configs: { production: { env_vars: { NODE_VERSION: { value: "22" } } } },
    }),
  });
  const projData = (await projRes.json()) as any;
  steps.push({
    name: "CF Pages",
    status: projData.success ? "ok" : "skip",
    detail: projData.success ? cfProject : projData.errors?.[0]?.message || "Exists",
  });

  // Custom domain
  const domRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${cfProject}/domains`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: subdomain }),
  });
  const domData = (await domRes.json()) as any;
  steps.push({ name: "Domain", status: domData.success ? "ok" : "skip", detail: domData.success ? subdomain : "Exists" });

  // DNS CNAME
  if (env.CF_GLOBAL_KEY) {
    const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${getZoneId(env, store)}/dns_records`, {
      method: "POST",
      headers: { "X-Auth-Email": env.CF_EMAIL, "X-Auth-Key": env.CF_GLOBAL_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "CNAME", name: id, content: `${cfProject}.pages.dev`, proxied: true }),
    });
    const dnsData = (await dnsRes.json()) as any;
    steps.push({
      name: "DNS",
      status: dnsData.success ? "ok" : "skip",
      detail: dnsData.success ? `${id} → ${cfProject}.pages.dev` : "Exists",
    });
  }

  // Registry
  const regPath = `/repos/${config.org}/${config.storeRepo}/contents/registry.json`;
  const regRes = await fetch(`https://api.github.com${regPath}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "freeappstore-publisher" },
  });
  const regFile = (await regRes.json()) as any;
  if (regFile.content) {
    const raw = new TextDecoder().decode(Uint8Array.from(atob(regFile.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
    const content = JSON.parse(raw);
    const items = content[config.registryKey] || [];
    if (!items.some((a: any) => a.id === id)) {
      items.push({
        id,
        name,
        category,
        icon,
        iconBg,
        description,
        appUrl: `https://${subdomain}`,
        repo: `${config.org}/${id}`,
        cfProject,
        type: "standalone",
        developer: creator,
      });
      content[config.registryKey] = items;
      const encoded = btoa(
        Array.from(new TextEncoder().encode(JSON.stringify(content, null, 2)))
          .map((b) => String.fromCharCode(b))
          .join(""),
      );
      await fetch(`https://api.github.com${regPath}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "freeappstore-publisher",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ message: `Add ${name} by @${creator}`, content: encoded, sha: regFile.sha }),
      });
      steps.push({ name: "Registry", status: "ok", detail: `Added ${name}` });
    } else {
      steps.push({ name: "Registry", status: "skip", detail: "Already listed" });
    }
  }

  // Notify admin — create issue in submissions repo
  // Sanitize: truncate fields and ensure creator is a validated username (no markdown injection)
  const safeName = name.slice(0, 60).replace(/[<>[\]@]/g, "");
  const safeCreator = creator.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 39);
  await fetch("https://api.github.com/repos/freeappstore-online/submissions/issues", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "freeappstore-publisher",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: `[Published] ${safeName} by ${safeCreator}`,
      body: `**${safeName}** (\`${id}\`) published by ${safeCreator}\n\n- Store: ${store}\n- Category: ${category}\n- URL: https://${subdomain}\n- Repo: https://github.com/${config.org}/${id}\n\nAuto-provisioned via publisher portal.`,
      labels: ["published", "needs-review"],
    }),
  });

  // Add creator to org team (creator already validated by getGitHubUser, but guard paths anyway)
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(creator) || creator.length > 39) {
    return { steps, success: steps.every((s) => s.status !== "fail") };
  }
  await fetch(`https://api.github.com/orgs/${config.org}/teams/creators/memberships/${creator}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "freeappstore-publisher" },
    body: JSON.stringify({ role: "member" }),
  });

  // Give creator push access to their repo
  await fetch(`https://api.github.com/repos/${config.org}/${id}/collaborators/${creator}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "freeappstore-publisher" },
    body: JSON.stringify({ permission: "push" }),
  });

  return { steps, success: steps.every((s) => s.status !== "fail") };
}

// ── CORS ──

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed =
    origin &&
    (origin.endsWith(".freeappstore.online") ||
      origin.endsWith(".freegamestore.online") ||
      origin === "https://freeappstore.online" ||
      origin === "https://freegamestore.online" ||
      (origin.endsWith(".pages.dev") && (origin.includes("freeappstore") || origin.includes("freegamestore"))) ||
      origin.startsWith("http://localhost"))
      ? origin
      : "https://freeappstore.online";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

// ── Main handler ──

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });

    const url = new URL(request.url);
    const user = await getGitHubUser(request, env);
    const headers = { "Content-Type": "application/json", ...cors(request) };

    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const creator = await getCreator(env, user);

    // GET /api/me — return creator info
    if (url.pathname === "/api/me" && request.method === "GET") {
      return new Response(JSON.stringify({ user, creator }), { headers });
    }

    // POST /api/create — provision a new app
    if (url.pathname === "/api/create" && request.method === "POST") {
      if (creator.banned) {
        return new Response(JSON.stringify({ error: "Account suspended" }), { status: 403, headers });
      }
      if (creator.apps.length >= creator.maxApps) {
        return new Response(JSON.stringify({ error: `Limit reached (${creator.maxApps} apps).` }), { status: 403, headers });
      }

      if (!(await checkRateLimit(env.CREATORS, user, "create", 3))) {
        return new Response(JSON.stringify({ error: "Rate limit: max 3 provisions per hour" }), { status: 429, headers });
      }

      const body = (await request.json()) as any;
      const idErr = validateId(body.id);
      if (idErr) return new Response(JSON.stringify({ error: idErr }), { status: 400, headers });
      if (!body.name || !body.store) return new Response(JSON.stringify({ error: "name and store required" }), { status: 400, headers });
      if (body.store === "games") {
        return new Response(
          JSON.stringify({
            error: "wrong_store",
            hint: "FGS publishes moved to admin.freegamestore.online (freegamestore-admin Worker). Use `fgs publish` or the FGS admin /api/provision endpoint.",
          }),
          { status: 410, headers },
        );
      }
      if (body.store !== "apps")
        return new Response(JSON.stringify({ error: "store must be apps" }), { status: 400, headers });
      if (typeof body.name !== "string" || body.name.length > 60)
        return new Response(JSON.stringify({ error: "name must be ≤60 characters" }), { status: 400, headers });
      if (body.description && (typeof body.description !== "string" || body.description.length > 200))
        return new Response(JSON.stringify({ error: "description must be ≤200 characters" }), { status: 400, headers });
      if (body.iconBg && !/^#[0-9a-fA-F]{3,8}$/.test(body.iconBg))
        return new Response(JSON.stringify({ error: "iconBg must be a hex color (e.g. #f0f9ff)" }), { status: 400, headers });
      if (body.icon && (typeof body.icon !== "string" || body.icon.length > 10 || /</.test(body.icon)))
        return new Response(JSON.stringify({ error: "icon must be an emoji (max 10 chars, no HTML)" }), { status: 400, headers });
      if (body.category && (typeof body.category !== "string" || body.category.length > 30 || !/^[a-z-]+$/.test(body.category)))
        return new Response(JSON.stringify({ error: "category must be lowercase letters/hyphens (e.g. utilities)" }), {
          status: 400,
          headers,
        });

      // Uniqueness: check if repo already exists and this creator doesn't own it
      const storeConfig = STORE_CONFIG[body.store]!;
      const repoCheck = await fetch(`https://api.github.com/repos/${storeConfig.org}/${body.id}`, {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "freeappstore-publisher",
        },
      });
      if (repoCheck.status === 200 && !creator.apps.some((a) => a.id === body.id)) {
        return new Response(JSON.stringify({ error: `ID "${body.id}" is already taken. Choose a different one.` }), {
          status: 409,
          headers,
        });
      }

      const result = await provision(
        env,
        body.id,
        body.name,
        body.category || "utilities",
        body.icon || "📱",
        body.iconBg || "#f0f9ff",
        body.description || body.name,
        body.store,
        user,
      );

      if (result.success) {
        creator.apps.push({ id: body.id, store: body.store, name: body.name, createdAt: new Date().toISOString().split("T")[0]! });
        await saveCreator(env, creator);
      }

      // Auto-audit the published app
      let audit = null;
      if (result.success) {
        const storeConfig2 = STORE_CONFIG[body.store]!;
        audit = await auditLive(`https://${body.id}.${storeConfig2.domain}`).catch(() => null);
      }

      return new Response(JSON.stringify({ ...result, audit }), { status: result.success ? 200 : 400, headers });
    }

    // POST /api/publish-existing — publish an already-deployed CF Pages app
    if (url.pathname === "/api/publish-existing" && request.method === "POST") {
      if (creator.banned) return new Response(JSON.stringify({ error: "Account suspended" }), { status: 403, headers });
      if (creator.apps.length >= creator.maxApps)
        return new Response(JSON.stringify({ error: `Limit reached (${creator.maxApps} apps).` }), { status: 403, headers });

      if (!(await checkRateLimit(env.CREATORS, user, "publish", 3))) {
        return new Response(JSON.stringify({ error: "Rate limit: max 3 provisions per hour" }), { status: 429, headers });
      }

      const body = (await request.json()) as any;
      const idErr = validateId(body.id);
      if (idErr) return new Response(JSON.stringify({ error: idErr }), { status: 400, headers });
      if (!body.name || !body.store || !body.pagesProject)
        return new Response(JSON.stringify({ error: "id, name, store, and pagesProject required" }), { status: 400, headers });
      if (body.store === "games") {
        return new Response(
          JSON.stringify({
            error: "wrong_store",
            hint: "FGS publish-existing moved to admin.freegamestore.online.",
          }),
          { status: 410, headers },
        );
      }
      if (body.store !== "apps")
        return new Response(JSON.stringify({ error: "store must be apps" }), { status: 400, headers });
      if (typeof body.name !== "string" || body.name.length > 60)
        return new Response(JSON.stringify({ error: "name must be ≤60 characters" }), { status: 400, headers });
      if (body.description && (typeof body.description !== "string" || body.description.length > 200))
        return new Response(JSON.stringify({ error: "description must be ≤200 characters" }), { status: 400, headers });
      if (body.iconBg && !/^#[0-9a-fA-F]{3,8}$/.test(body.iconBg))
        return new Response(JSON.stringify({ error: "iconBg must be a hex color" }), { status: 400, headers });
      if (body.icon && (typeof body.icon !== "string" || body.icon.length > 10 || /</.test(body.icon)))
        return new Response(JSON.stringify({ error: "icon must be an emoji (max 10 chars, no HTML)" }), { status: 400, headers });
      if (body.category && (typeof body.category !== "string" || body.category.length > 30 || !/^[a-z-]+$/.test(body.category)))
        return new Response(JSON.stringify({ error: "category must be lowercase letters/hyphens" }), { status: 400, headers });

      const config = STORE_CONFIG[body.store]!;
      const cfProject = body.pagesProject as string;
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(cfProject) || cfProject.length > 63) {
        return new Response(JSON.stringify({ error: "Invalid pagesProject name" }), { status: 400, headers });
      }
      const subdomain = `${body.id}.${config.domain}`;
      const steps: { name: string; status: string; detail: string }[] = [];

      // Verify the CF Pages project exists
      const projCheck = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${cfProject}`, {
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      });
      const projData = (await projCheck.json()) as any;
      if (!projData.success) {
        return new Response(JSON.stringify({ error: `CF Pages project "${cfProject}" not found. Deploy it first.` }), {
          status: 404,
          headers,
        });
      }

      // M-6: Verify the project belongs to a platform org
      const source = projData.result?.source;
      const sourceOwner = source?.config?.owner;
      if (sourceOwner !== "freeappstore-online" && sourceOwner !== "freegamestore-online") {
        return new Response(JSON.stringify({ error: "Only platform-provisioned projects can be published" }), { status: 403, headers });
      }

      steps.push({ name: "CF Pages", status: "skip", detail: `${cfProject}.pages.dev (existing)` });

      // Custom domain
      const domRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${cfProject}/domains`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: subdomain }),
      });
      const domData = (await domRes.json()) as any;
      steps.push({ name: "Domain", status: domData.success ? "ok" : "skip", detail: domData.success ? subdomain : "Exists" });

      // DNS CNAME
      if (env.CF_GLOBAL_KEY) {
        const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${getZoneId(env, body.store)}/dns_records`, {
          method: "POST",
          headers: { "X-Auth-Email": env.CF_EMAIL, "X-Auth-Key": env.CF_GLOBAL_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "CNAME", name: body.id, content: `${cfProject}.pages.dev`, proxied: true }),
        });
        const dnsData = (await dnsRes.json()) as any;
        steps.push({
          name: "DNS",
          status: dnsData.success ? "ok" : "skip",
          detail: dnsData.success ? `${body.id} → ${cfProject}.pages.dev` : "Exists",
        });
      }

      // Registry
      const regPath = `/repos/${config.org}/${config.storeRepo}/contents/registry.json`;
      const regRes = await fetch(`https://api.github.com${regPath}`, {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "freeappstore-publisher",
        },
      });
      const regFile = (await regRes.json()) as any;
      if (regFile.content) {
        const raw = new TextDecoder().decode(Uint8Array.from(atob(regFile.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
        const content = JSON.parse(raw);
        const items = content[config.registryKey] || [];
        if (!items.some((a: any) => a.id === body.id)) {
          items.push({
            id: body.id,
            name: body.name,
            category: body.category || "utilities",
            icon: body.icon || "📱",
            iconBg: body.iconBg || "#f0f9ff",
            description: body.description || body.name,
            appUrl: `https://${subdomain}`,
            cfProject,
            type: "standalone",
            developer: user,
          });
          content[config.registryKey] = items;
          const encoded = btoa(
            Array.from(new TextEncoder().encode(JSON.stringify(content, null, 2)))
              .map((b) => String.fromCharCode(b))
              .join(""),
          );
          await fetch(`https://api.github.com${regPath}`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "freeappstore-publisher",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({ message: `Publish ${body.name} by @${user}`, content: encoded, sha: regFile.sha }),
          });
          steps.push({ name: "Registry", status: "ok", detail: `Added ${body.name}` });
        } else {
          steps.push({ name: "Registry", status: "skip", detail: "Already listed" });
        }
      }

      const success = steps.every((s) => s.status !== "fail");
      if (success) {
        creator.apps.push({ id: body.id, store: body.store, name: body.name, createdAt: new Date().toISOString().split("T")[0]! });
        await saveCreator(env, creator);
      }

      // Auto-audit
      let audit = null;
      if (success) {
        const subdomain2 = `${body.id}.${config.domain}`;
        audit = await auditLive(`https://${subdomain2}`).catch(() => null);
      }

      return new Response(JSON.stringify({ steps, success, audit }), { status: success ? 200 : 400, headers });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers });
  },
};
