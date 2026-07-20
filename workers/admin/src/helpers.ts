/** Shared data-fetching helpers used by the admin worker routes. */

export interface Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  GITHUB_TOKEN: string;
  CI_TOKEN: string;
  /** Provisioning control-plane token shared with the FAS backend
   *  (freeappstore-api). Authenticates server-to-server calls (backend ->
   *  /api/provision via service binding, admin -> backend analytics, admin's
   *  own /api/unpublish self-call) that carry no CF Access JWT. Managed from
   *  the private SOPS secrets repo and synced on rotation/touch. */
  ADMIN_PROVISION_TOKEN?: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  DB: D1Database;
  CREATORS: KVNamespace;
  /** Path B host bucket (fas-apps) — deprovision purges apps/<id>/* here. */
  APPS?: R2Bucket;
  /** Service binding to the FAS platform backend for internal admin operations. */
  BACKEND_FAS?: Fetcher;
  /** Service binding to the agent Worker (freeappstore-agent). agent.freeappstore.online
   *  is route-mapped on this zone, so a plain same-zone fetch() would bypass it —
   *  the session-history read must go through this binding. */
  AGENT?: Fetcher;
  /** Legacy alias for the backend internal token. Prefer ADMIN_PROVISION_TOKEN. */
  INTERNAL_TOKEN?: string;
  FAS_ZONE_ID: string;
  FGS_ZONE_ID: string;
}

export interface AppConfig {
  id: string;
  name: string;
  store: "apps" | "games";
  org: string;
  domain: string;
  category?: string;
  repo?: string;
}

function safeJson(raw: unknown): any {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const REGISTRY_URLS = {
  apps: "https://raw.githubusercontent.com/freeappstore-online/freeappstore/main/registry.json",
  games: "https://raw.githubusercontent.com/freegamestore-online/freegamestore/main/registry.json",
};

const STORE_META = {
  apps: { org: "freeappstore-online", domain: "freeappstore.online" },
  games: { org: "freegamestore-online", domain: "freegamestore.online" },
};

export async function fetchRegistry(store: "apps" | "games"): Promise<AppConfig[]> {
  const res = await fetch(REGISTRY_URLS[store], { headers: { "User-Agent": "freeappstore-admin" } });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  const key = store === "apps" ? "apps" : "games";
  const items = data[key] || [];
  const meta = STORE_META[store];
  return items.map((item: any) => ({
    id: item.id,
    name: item.name,
    store,
    org: meta.org,
    domain: `${item.id}.${meta.domain}`,
    category: item.category,
  }));
}

export async function fetchTraffic(env: Env): Promise<{ fas: any; fgs: any } | null> {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const query = `query ($zoneId: String!, $since: String!) {
    viewer { zones(filter: {zoneTag: $zoneId}) {
      httpRequests1dGroups(limit: 30, filter: {date_gt: $since}) {
        dimensions { date }
        sum { requests pageViews }
        uniq { uniques }
      }
    }}
  }`;

  async function queryZone(zoneId: string) {
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { zoneId, since } }),
      });
      const data = (await res.json()) as any;
      const days = data.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
      const totals = days.reduce(
        (acc: any, d: any) => ({
          requests: acc.requests + (d.sum?.requests || 0),
          pageViews: acc.pageViews + (d.sum?.pageViews || 0),
          visitors: acc.visitors + (d.uniq?.uniques || 0),
        }),
        { requests: 0, pageViews: 0, visitors: 0 },
      );
      return { days, totals };
    } catch {
      return null;
    }
  }

  const [fas, fgs] = await Promise.all([queryZone(env.FAS_ZONE_ID), queryZone(env.FGS_ZONE_ID)]);
  return { fas, fgs };
}

export async function fetchGhRuns(appId: string, env: Env) {
  try {
    const res = await fetch(`https://api.github.com/repos/freeappstore-online/${appId}/actions/runs?per_page=5`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "freeappstore-admin",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data.workflow_runs ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      headSha: r.head_sha?.slice(0, 7),
      commitMsg: r.head_commit?.message?.split("\n")[0]?.slice(0, 80),
    }));
  } catch {
    return [];
  }
}

export type DeployStatus = {
  status: string | null;
  conclusion: string | null;
  at: string | null;
  sha: string | null;
};

/** Latest GitHub Actions deploy conclusion for every provisioned app.
 *  Fan-out is concurrency-limited; the caller caches the whole result (5 min)
 *  so the Apps list can flag failed deploys at a glance without hammering GitHub. */
export async function handleDeployStatus(env: Env): Promise<Record<string, DeployStatus>> {
  const rows = await env.DB.prepare("SELECT id FROM apps ORDER BY id").all();
  const ids = (rows.results ?? []).map((r) => r.id as string);
  const result: Record<string, DeployStatus> = {};
  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (id) => {
        const runs = await fetchGhRuns(id, env);
        const latest = runs[0];
        result[id] = latest
          ? { status: latest.status ?? null, conclusion: latest.conclusion ?? null, at: latest.createdAt ?? null, sha: latest.headSha ?? null }
          : { status: null, conclusion: null, at: null, sha: null };
      }),
    );
  }
  return result;
}

export async function handleAppsAll(env: Env) {
  const [routeRows, appRows, appsReg, gamesReg, userRows] = await Promise.all([
    env.DB.prepare("SELECT slug, zone, r2_prefix, store, hosted_on, created_at, updated_at FROM routes ORDER BY slug").all(),
    env.DB.prepare("SELECT id, owner_login, category, type, oneliner, display_name, repo, created_at FROM apps ORDER BY id").all(),
    fetchRegistry("apps"),
    fetchRegistry("games"),
    env.DB.prepare("SELECT github_login, avatar_url FROM users").all(),
  ]);
  const registryMap = new Map<string, AppConfig>();
  for (const a of [...appsReg, ...gamesReg]) registryMap.set(a.id, a);

  const usersMap = new Map<string, string>();
  for (const u of userRows.results ?? []) {
    if (u.github_login && u.avatar_url) usersMap.set(u.github_login as string, u.avatar_url as string);
  }

  const appsMap = new Map<string, any>();
  for (const row of appRows.results ?? []) appsMap.set(row.id as string, row);

  const combined: any[] = [];
  const seen = new Set<string>();

  for (const r of routeRows.results ?? []) {
    const slug = r.slug as string;
    seen.add(slug);
    const reg = registryMap.get(slug);
    const app = appsMap.get(slug);
    const owner = app?.owner_login ?? null;
    combined.push({
      id: slug,
      name: reg?.name ?? app?.display_name ?? app?.oneliner ?? slug,
      store: (r.store as string) || "apps",
      domain: `${slug}.${r.zone}`,
      hostedOn: r.hosted_on ?? "r2",
      r2Prefix: r.r2_prefix,
      inRegistry: !!reg,
      owner,
      ownerAvatar: owner ? (usersMap.get(owner) ?? `https://avatars.githubusercontent.com/${owner}?size=80`) : null,
      category: reg?.category ?? app?.category ?? null,
      type: app?.type ?? null,
      repo: reg?.repo ?? app?.repo ?? `freeappstore-online/${slug}`,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  for (const [id, reg] of registryMap) {
    if (seen.has(id)) continue;
    const app = appsMap.get(id);
    const owner = app?.owner_login ?? null;
    combined.push({
      id,
      name: reg.name,
      store: reg.store,
      domain: reg.domain,
      hostedOn: "orphan",
      r2Prefix: null,
      inRegistry: true,
      owner,
      ownerAvatar: owner ? (usersMap.get(owner) ?? `https://avatars.githubusercontent.com/${owner}?size=80`) : null,
      category: reg.category ?? app?.category ?? null,
      type: app?.type ?? null,
      repo: reg.repo ?? `freeappstore-online/${id}`,
      createdAt: app?.created_at ?? null,
      updatedAt: null,
    });
  }
  return combined;
}

export async function handleAppHealth(appId: string, env: Env) {
  const [routeRow, ghRuns] = await Promise.all([
    env.DB.prepare("SELECT slug, zone, hosted_on FROM routes WHERE slug = ?").bind(appId).first(),
    fetchGhRuns(appId, env),
  ]);

  const domain = routeRow ? `${routeRow.slug}.${routeRow.zone}` : `${appId}.freeappstore.online`;

  let httpStatus = 0;
  try {
    const res = await fetch(`https://${domain}`, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    httpStatus = res.status;
  } catch {
    /* timeout or network error */
  }

  return {
    id: appId,
    domain,
    hostedOn: routeRow?.hosted_on ?? "unknown",
    hasRoute: !!routeRow,
    httpStatus,
    reachable: httpStatus >= 200 && httpStatus < 400,
    ghActions: ghRuns,
  };
}

export async function handleAgentSessions(url: URL, env: Env) {
  const page = Math.max(1, Math.min(9999, parseInt(url.searchParams.get("page") || "1") || 1));
  const limit = 50;
  const offset = (page - 1) * limit;
  const search = url.searchParams.get("q") || "";

  let query = "SELECT session_id, user_id, name, app_id, app_url, deployed, deploy_state, created_at, updated_at FROM agent_sessions";
  const params: any[] = [];

  if (search) {
    query += " WHERE name LIKE ? OR app_id LIKE ? OR session_id LIKE ?";
    const escaped = search.replace(/[%_]/g, "\\$&");
    const like = `%${escaped}%`;
    params.push(like, like, like);
  }
  query += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const countQuery = search
    ? "SELECT COUNT(*) as count FROM agent_sessions WHERE name LIKE ? OR app_id LIKE ? OR session_id LIKE ?"
    : "SELECT COUNT(*) as count FROM agent_sessions";
  const countParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

  const [rows, total] = await Promise.all([
    env.DB.prepare(query)
      .bind(...params)
      .all(),
    env.DB.prepare(countQuery)
      .bind(...countParams)
      .first<{ count: number }>(),
  ]);

  return {
    sessions: (rows.results ?? []).map((r: any) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      name: r.name,
      appId: r.app_id,
      appUrl: r.app_url,
      deployed: !!r.deployed,
      deployState: safeJson(r.deploy_state),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total: total?.count ?? 0,
    page,
    pages: Math.ceil((total?.count ?? 0) / limit),
  };
}

/** Try to load messages from D1 row, falling back to the agent DO if D1 has none. */
async function loadMessages(rawMessages: unknown, sessionId: string, env: Env): Promise<unknown[]> {
  let messages: unknown[] = [];
  try {
    messages = rawMessages ? JSON.parse(rawMessages as string) : [];
  } catch {
    /* malformed JSON */
  }
  if (messages.length === 0 && sessionId) {
    try {
      // agent.freeappstore.online is route-mapped on this zone — a plain
      // same-zone fetch() bypasses the agent Worker, so go through the AGENT
      // service binding (host ignored for bound calls). Fall back to the
      // public URL only when the binding is absent (local dev / cross-zone).
      const historyUrl = `https://agent.freeappstore.online/session/${sessionId}/history`;
      const doRes = env.AGENT
        ? await env.AGENT.fetch(historyUrl, { signal: AbortSignal.timeout(5000) })
        : await fetch(historyUrl, { signal: AbortSignal.timeout(5000) });
      if (doRes.ok) {
        const doData = (await doRes.json()) as { messages?: unknown[] };
        if (doData.messages?.length) messages = doData.messages;
      }
    } catch {
      /* DO evicted or unreachable */
    }
  }
  return messages;
}

export async function handleAgentSessionDetail(sessionId: string, env: Env) {
  const row = await env.DB.prepare(
    "SELECT session_id, user_id, name, app_id, app_url, deployed, messages, deploy_state, created_at, updated_at FROM agent_sessions WHERE session_id = ?",
  )
    .bind(sessionId)
    .first();

  if (!row) return null;

  const messages = await loadMessages(row.messages, sessionId, env);

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    name: row.name,
    appId: row.app_id,
    appUrl: row.app_url,
    deployed: !!row.deployed,
    deployState: safeJson(row.deploy_state),
    messages,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function handleAppSessions(appId: string, env: Env) {
  const rows = await env.DB.prepare(
    "SELECT session_id, user_id, name, app_id, deployed, deploy_state, messages, created_at, updated_at FROM agent_sessions WHERE app_id = ? ORDER BY updated_at DESC LIMIT 10",
  )
    .bind(appId)
    .all();

  const sessions = await Promise.all(
    (rows.results ?? []).map(async (r: any) => {
      const messages = await loadMessages(r.messages, r.session_id, env);

      return {
        sessionId: r.session_id,
        userId: r.user_id,
        name: r.name,
        deployed: !!r.deployed,
        deployState: safeJson(r.deploy_state),
        messages,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }),
  );

  return sessions;
}
