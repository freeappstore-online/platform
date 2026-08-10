/** Execute infra tools server-side. Extracted from session.ts to keep it manageable. */

import { checkBuildSanity, formatSanityBlock } from "./build-sanity";
import type { StoreConfig } from "./config";
import type { DeployEnv, DeployStatus } from "./deploy";
import { deployApp, pushUpdate, waitForGitHubDeploy } from "./deploy";
import { checkDeployStatus, fetchUrl, getAuditResults, getBuildLogs, getCIResults, listDeployed } from "./infra";
import type { ToolCall } from "./providers/types";

interface ExecContext {
  appId: string | null;
  ownerLogin: string | null;
  authHeader?: string;
  files: Map<string, string>;
  env: DeployEnv;
  config: StoreConfig;
  onDeployStatus: (status: DeployStatus) => void;
  onAppDeployed: (id: string, name: string) => void;
}

/** Execute a single infra tool. Returns the result string. */
export async function executeInfraTool(tc: ToolCall, ctx: ExecContext): Promise<string> {
  const { config } = ctx;

  // Authorization: scope write tools to the session's own item
  const targetId = tc.input.id as string | undefined;
  if (targetId && ["push_update", "get_build_logs", "get_ci_results", "check_deploy_status", "get_audit_results"].includes(tc.name)) {
    if (!ctx.appId) return `Error: no ${config.noun} deployed yet. Deploy first before using ${tc.name}.`;
    if (targetId !== ctx.appId)
      return `Error: you can only ${tc.name} on your own ${config.noun} "${ctx.appId}". No access to "${targetId}".`;
  }

  // Validate deploy ID
  if (tc.name === "deploy" && tc.input.id) {
    const id = tc.input.id as string;
    const RESERVED = [
      "platform",
      "admin",
      "api",
      "agent",
      "publish",
      "create",
      "sdk",
      "freeappstore",
      "freegamestore",
      "store",
      "www",
      "mail",
      "status",
    ];
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id) ||
      id.length > 58 ||
      id.startsWith("free") ||
      id.startsWith("pro") ||
      RESERVED.includes(id)
    ) {
      return `Error: invalid ${config.noun} ID "${id}". Must be lowercase, numbers, hyphens. No "free"/"pro" prefix, no reserved names. Max 58 chars.`;
    }
    if (ctx.appId && ctx.appId !== id) {
      return `Error: this session already deployed "${ctx.appId}". Create a new project for a different ${config.noun}.`;
    }
  }

  if (tc.name === "deploy" || tc.name === "push_update") {
    const findings = checkBuildSanity(ctx.files);
    if (findings.length) {
      ctx.onDeployStatus({
        phase: "error",
        error: `Build check failed: ${findings.map((finding) => finding.file).join(", ")}`,
      });
      return formatSanityBlock(findings, config.noun);
    }
  }

  switch (tc.name) {
    case "deploy":
      return executeDeploy(tc, ctx);
    case "push_update":
      return executePushUpdate(tc, ctx);
    case "check_deploy_status":
      return checkDeployStatus(targetId!, ctx.env, config);
    case "list_deployed_apps":
    case "list_deployed_games":
      return listDeployed(ctx.env, config);
    case "fetch_url":
      return executeFetchUrl(tc, config);
    case "get_build_logs":
      return getBuildLogs(targetId!, ctx.env, config);
    case "get_ci_results":
      return getCIResults(targetId!, ctx.env, config);
    case "get_audit_results":
      return getAuditResults(targetId!, config);
    default:
      return `Unknown infra tool: ${tc.name}`;
  }
}

/**
 * True if a repo with this id already exists in the org.
 *
 * Only 200 and 404 are answers. A 403 (rate limit), 429 or 5xx says nothing
 * about existence, and reporting "free" there is what let three sessions
 * deploy under one id (#29) — so anything else aborts the deploy instead.
 */
async function repoExists(id: string, ctx: ExecContext): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${ctx.config.org}/${id}`, {
    headers: {
      Authorization: `Bearer ${ctx.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": ctx.config.agentName,
    },
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(
    `GitHub returned ${res.status} while checking whether "${id}" is free. Not deploying — this would risk overwriting another ${ctx.config.noun}. Try again shortly.`,
  );
}

/** Current owner_login for an id, or null if unclaimed / no DB binding. */
async function appOwner(id: string, ctx: ExecContext): Promise<string | null> {
  if (!ctx.env.DB) return null;
  const row = await ctx.env.DB.prepare(`SELECT owner_login FROM apps WHERE id = ?`).bind(id).first<{ owner_login: string }>();
  return row?.owner_login ?? null;
}

/**
 * May this caller deploy into `id`?
 *
 * The `apps` row is the authority on ownership — not the GitHub repo, which is
 * only a side effect of a past deploy. A repo with no `apps` row is treated as
 * taken: we cannot prove it is ours, and pushing into it would overwrite a
 * stranger's app.
 */
async function isAvailableTo(id: string, ctx: ExecContext): Promise<boolean> {
  const owner = await appOwner(id, ctx);
  if (owner) return owner === ctx.ownerLogin;
  // With no ownership store there is nothing to consult, so fall back to the
  // session's own id — a redeploy of what this session just built. Never do
  // this when D1 *is* available: an unclaimed id whose repo exists is someone
  // else's orphan, and session state is exactly the signal that mislead us
  // into deploying over a stranger's app (#29).
  if (!ctx.env.DB && ctx.appId === id) return true;
  return !(await repoExists(id, ctx));
}

/**
 * Resolve a collision-free id. Returns the requested id if available, else the
 * first free `-2`, `-3`, … variant. Checking up front and picking an available
 * id beats erroring back to the model, which just guesses another name and
 * collides again. Trims the base so the suffix stays within the 58-char limit.
 */
async function resolveAvailableId(baseId: string, ctx: ExecContext): Promise<string> {
  if (await isAvailableTo(baseId, ctx)) return baseId;
  for (let n = 2; n <= 50; n++) {
    const suffix = `-${n}`;
    const candidate = `${baseId.slice(0, 58 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (await isAvailableTo(candidate, ctx)) return candidate;
  }
  throw new Error(`Could not find an available ${ctx.config.noun} ID based on "${baseId}". Try a different name.`);
}

type Claim = { ok: true; createdNow: boolean; ownedAlready: boolean } | { ok: false; error: string };

/**
 * Take ownership of `appId` *before* any code is pushed.
 *
 * `INSERT … DO NOTHING` is atomic, so two sessions racing the same id cannot
 * both win; reading the row back tells us which one did. The old code inserted
 * with `OR IGNORE` *after* a successful deploy, so the loser silently got no
 * ownership row and an app invisible in their console (#29).
 */
async function claimApp(appId: string, appName: string, tc: ToolCall, ctx: ExecContext): Promise<Claim> {
  if (!ctx.env.DB || !ctx.ownerLogin) return { ok: true, createdNow: false, ownedAlready: false };

  const priorOwner = await appOwner(appId, ctx);
  if (priorOwner && priorOwner !== ctx.ownerLogin) {
    return { ok: false, error: `"${appId}" already belongs to another account. Deploy under a different ID.` };
  }

  await ctx.env.DB.prepare(
    `INSERT INTO apps (id, owner_login, created_at, category, type, oneliner, display_name, store)
       VALUES (?, ?, ?, ?, 'standalone', ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
  )
    .bind(
      appId,
      ctx.ownerLogin,
      Date.now(),
      (tc.input.category as string) || "utilities",
      (tc.input.description as string) || appName,
      appName,
      ctx.config.store,
    )
    .run();

  // Read back: if a concurrent session won the insert, the row is theirs.
  const owner = await appOwner(appId, ctx);
  if (owner !== ctx.ownerLogin) {
    return { ok: false, error: `"${appId}" was claimed by another account moments ago. Deploy under a different ID.` };
  }
  return { ok: true, createdNow: !priorOwner, ownedAlready: priorOwner === ctx.ownerLogin };
}

/** Undo a claim made moments ago by this call, so a failed deploy leaves no phantom app. */
async function releaseApp(appId: string, ctx: ExecContext): Promise<void> {
  if (!ctx.env.DB || !ctx.ownerLogin) return;
  try {
    await ctx.env.DB.prepare(`DELETE FROM apps WHERE id = ? AND owner_login = ?`).bind(appId, ctx.ownerLogin).run();
  } catch {
    /* best-effort rollback */
  }
}

async function executeDeploy(tc: ToolCall, ctx: ExecContext): Promise<string> {
  const requestedId = tc.input.id as string;
  const appName = tc.input.name as string;

  // Always check for duplicates before choosing the id: if the requested id is
  // taken, deploy under the next available `-N` variant instead of failing.
  // This runs unconditionally — the old `if (!ctx.appId)` guard skipped it on
  // any turn where a previous attempt had already set the session's appId, so
  // a retry after a failed deploy went straight into the colliding id (#29).
  // Redeploys still keep their id: `isAvailableTo` recognises apps we own.
  let appId: string;
  try {
    appId = await resolveAvailableId(requestedId, ctx);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Record ownership before pushing anything, so a lost race fails loudly here
  // rather than silently producing an app its builder can never see.
  let claim: Claim;
  try {
    claim = await claimApp(appId, appName, tc, ctx);
  } catch (e) {
    return `Error: could not record ownership of "${appId}": ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!claim.ok) {
    ctx.onDeployStatus({ phase: "error", error: claim.error });
    return `Deploy FAILED: ${claim.error}`;
  }

  // Replace placeholders: APPNAME -> display name (or the id in package.json),
  // APPID -> the lowercase app id everywhere (used by the SDK: initApp({ appId: "APPID" })).
  applyPlaceholders(ctx.files, appId, appName);

  ctx.onAppDeployed(appId, appName);

  let deployError: string | null = null;
  let liveUrl: string | null = null;
  await deployApp(
    {
      id: appId,
      name: appName,
      category: tc.input.category as string,
      icon: tc.input.icon as string,
      iconBg: tc.input.iconBg as string,
      description: tc.input.description as string,
    },
    ctx.files,
    ctx.env,
    ctx.config,
    (status) => {
      ctx.onDeployStatus(status);
      if (status.phase === "live") liveUrl = status.appUrl;
      if (status.phase === "error") deployError = status.error;
    },
    // Only reuse an existing repo when it is provably ours.
    claim.ownedAlready || (!ctx.env.DB && ctx.appId === appId),
  ).catch((err) => {
    deployError = String(err);
  });

  if (deployError) {
    // Release a claim we took moments ago only if nothing was provisioned under
    // it — otherwise keep it, so the retry can reuse the repo it already made
    // and no one else can take the id out from under a half-built app.
    if (claim.createdNow && !(await repoExists(appId, ctx).catch(() => true))) {
      await releaseApp(appId, ctx);
    }
    ctx.onDeployStatus({ phase: "error", error: deployError });
    return `Deploy FAILED: ${deployError}`;
  }

  const publishError = await publishStoreListing(appId, appName, tc, ctx);

  // Insert D1 hosting route so the host worker can serve this app from R2.
  // Ownership was already settled by claimApp above; the WHERE clause is a
  // second lock on the same door — an existing route is only ever repointed
  // when the app it serves is ours (or is unclaimed). Without it a colliding
  // deploy would redirect a live app at another owner's URL to its own bundle.
  if (ctx.env.DB) {
    const r2Prefix = `${ctx.config.nounPlural}/${appId}`;
    try {
      await ctx.env.DB.prepare(
        `INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'r2', ?5, ?5)
           ON CONFLICT (slug, zone) DO UPDATE SET
             r2_prefix = excluded.r2_prefix, store = excluded.store,
             hosted_on = excluded.hosted_on, updated_at = excluded.updated_at
           WHERE EXISTS (SELECT 1 FROM apps WHERE apps.id = routes.slug AND apps.owner_login = ?6)
              OR NOT EXISTS (SELECT 1 FROM apps WHERE apps.id = routes.slug)`,
      )
        .bind(appId, ctx.config.domain, r2Prefix, ctx.config.store, Date.now(), ctx.ownerLogin)
        .run();
    } catch {
      /* D1 insert failed — app deploys but won't be routable until published */
    }
  }

  const renamed = appId !== requestedId ? ` (ID "${requestedId}" was taken — deployed as "${appId}")` : "";
  const listing = publishError ? ` Store listing failed: ${publishError}` : " Store listing published.";
  return `Deploy succeeded${renamed}. Preview: ${liveUrl || "building..."}.${listing}`;
}

async function publishStoreListing(appId: string, appName: string, tc: ToolCall, ctx: ExecContext): Promise<string | null> {
  if (!ctx.env.PLATFORM || !ctx.authHeader) return "platform publish binding unavailable";
  try {
    const description = String(tc.input.description || appName);
    const res = await ctx.env.PLATFORM.fetch("https://backend/v1/publish", {
      method: "POST",
      headers: {
        Authorization: ctx.authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: appId,
        store: "apps",
        category: normalizePublishCategory(String(tc.input.category || "Utilities")),
        type: "standalone",
        oneliner: description,
        description,
        repo: `${ctx.config.org}/${appId}`,
        demo: null,
      }),
    });
    if (res.ok) return null;
    const body = await res.text().catch(() => "");
    return `${res.status} ${body.slice(0, 300)}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function normalizePublishCategory(category: string): string {
  const normalized = category.trim().toLowerCase();
  const map: Record<string, string> = {
    utilities: "Utilities",
    productivity: "Productivity",
    learning: "Learning",
    lifestyle: "Lifestyle",
    finance: "Finance",
    health: "Health & Fitness",
    "health & fitness": "Health & Fitness",
    creative: "Creative",
    social: "Social",
    discovery: "Discovery",
    strategy: "Strategy",
    "brain training": "Brain Training",
  };
  return map[normalized] || "Other (specify in description)";
}

/** Replace APPNAME (display name; id in package.json) + APPID (the slug, everywhere). */
export function applyPlaceholders(files: Map<string, string>, appId: string, appName: string): void {
  for (const [path, content] of files) {
    if (!content.includes("APPNAME") && !content.includes("APPID")) continue;
    let next = content.replace(/APPID/g, appId);
    next = path.includes("package.json") ? next.replace(/APPNAME/g, appId) : next.replace(/APPNAME/g, appName);
    files.set(path, next);
  }
}

async function executePushUpdate(tc: ToolCall, ctx: ExecContext): Promise<string> {
  // Post-deploy edits may reintroduce the APPID placeholder (e.g. the SDK
  // initApp call). Resolve it against the deployed id before pushing.
  if (ctx.appId) applyPlaceholders(ctx.files, ctx.appId, ctx.appId);
  ctx.onDeployStatus({ phase: "pushing", progress: "Pushing update..." });
  const result = await pushUpdate(tc.input.id as string, ctx.files, (tc.input.message as string) || "Update", ctx.env, ctx.config);
  if (!result.ok) {
    ctx.onDeployStatus({ phase: "error", error: result.message });
    return result.message;
  }
  await waitForGitHubDeploy(tc.input.id as string, ctx.env, ctx.config, ctx.onDeployStatus, result.commitSha);
  return result.message;
}

async function executeFetchUrl(tc: ToolCall, config: StoreConfig): Promise<string> {
  const url = tc.input.url as string;
  if (!url.startsWith("https://")) {
    return "Error: can only fetch public HTTPS URLs.";
  }
  // Block private IPs and internal platform services
  if (/localhost|127\.|192\.168|10\.|172\.1[6-9]\.|172\.2|172\.3[01]\.|169\.254|0\.0\.0\.0|\[::1\]/i.test(url)) {
    return "Error: cannot fetch private/internal URLs.";
  }
  if (
    /admin\.(freeappstore|freegamestore)|publish\.(freeappstore|freegamestore)|agent\.(freeappstore|freegamestore)|api\.(freeappstore|freegamestore)\.online\/v1\/(publish|apps|auth\/(exchange|me))/i.test(
      url,
    )
  ) {
    return "Error: cannot fetch internal platform URLs.";
  }
  return fetchUrl(url, (tc.input.method as string) || "GET", config.agentName);
}
