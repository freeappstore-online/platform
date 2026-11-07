import { MAX_TOOL_INPUT_ELEMENTS, withBoundedBody } from "./request-limits.js";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { MCP_ACCESS_TOKEN_TTL_SECONDS } from "./oauth-config.js";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listRepoFiles, pushFiles, readRepoBytes, readRepoFile, textToB64 } from "./github.js";
import { getDeployStatus } from "./deploy-status.js";
import { createAppProblems, planScaffold, preflightUpdate } from "./preflight.js";
import { buildScaffold } from "./scaffold.js";
import { AuthHandler } from "./auth-handler.js";
import { sessionPrefix, auditLog } from "./lib.js";
import { ownsApp, ownershipGateText } from "./ownership.js";
import { withOriginCheck } from "./origin.js";
import { type RateLimiter, withRateLimit } from "./ratelimit.js";
import { audit, listAuditEvents, MCP_SCOPES, requirePermission, type SafetyContext } from "./safety.js";
import { BUILD_HANDOFF_BLOCK, getSdkReference, SDK_REFERENCE_FEATURES, withBuildHandoff } from "./sdk-reference.js";
import { formatAgentActivity, formatAgentStatus } from "./agent-observability.js";

interface Env {
  API_BASE: string;
  GITHUB_ORG: string;
  AGENT_BASE: string;
  MCP_OBJECT: DurableObjectNamespace;
  GITHUB_TOKEN?: string;
  OAUTH_KV?: KVNamespace;
  /** When "1", all non-read tools are disabled server-wide. */
  MCP_READ_ONLY?: string;
  /** Per-IP request limit, applied before routing (see ratelimit.ts). */
  MCP_RATE_LIMIT?: RateLimiter;
}

// FAS backend API
async function fasApi(apiBase: string, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, { headers });
  if (!res.ok) return { error: `API ${res.status}: ${await res.text()}` };
  return await res.json();
}

// POST to the FAS backend (e.g. /v1/publish — the same path `fas publish` uses).
async function fasPost(apiBase: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) return { error: json.error ?? `API ${res.status}`, detail: json.detail ?? json.body ?? text, status: res.status };
  return json;
}

const txt = (text: string) => ({ content: [{ type: "text" as const, text }] });
const toolError = (text: string) => ({ ...txt(text), isError: true });

const NOT_SIGNED_IN = "Not signed in to FreeAppStore. Reconnect the FreeAppStore connector, sign in, then retry.";

// Every tool carries a title and all three hints as explicit booleans: the
// Claude Connectors Directory and the ChatGPT Apps Directory both reject tools
// without them (#539). openWorldHint is false throughout — every tool works on
// the bounded FreeAppStore catalog or the caller's own account.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
/** Writes that can overwrite existing content. */
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

// sessionPrefix, auditLog, decodeUid are in lib.ts for testability.

export interface McpProps extends Record<string, unknown> {
  userId?: string;
  token?: string;
  readOnly?: boolean;
  /** MCP scopes granted by the OAuth token (null/undefined → read, write, runtime). */
  scopes?: string[] | null;
}



export class FasMcpAgent extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "FreeAppStore",
    version: "0.2.0",
  }, { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS });

  // The OAuth provider only routes authenticated requests to this handler, so
  // props (set in completeAuthorization) are always present for tool calls.
  declare props: McpProps;

  /** Safety context for the current authenticated user — scope/permission
   *  gating + user-scoped KV audit. See safety.ts. */
  safety(): SafetyContext {
    return {
      env: this.env,
      subject: this.props.userId,
      scopes: this.props.scopes ?? null,
      readOnly: this.props.readOnly,
    };
  }

  async init() {
    // ── mcp_audit_log ──────────────────────────────────────────
    this.server.registerTool(
      "mcp_audit_log",
      {
        title: "Read my audit log",
        description: "Read your recent MCP audit events for this account — every write/dry-run/denied tool action, newest first. User-scoped.",
        annotations: READ,
        inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Max events to return (default 50)") },
      },
      async ({ limit }) => {
        const denied = await requirePermission(this.safety(), "read", "mcp_audit_log", { limit });
        if (denied) return denied;
        return txt(JSON.stringify(await listAuditEvents(this.safety(), limit ?? 50), null, 2));
      },
    );

    // ── list_apps ──────────────────────────────────────────────
    this.server.registerTool(
      "list_apps",
      {
        title: "List my apps",
        description: "List the apps you have published on FreeAppStore: id, category, one-line description, live URL and repository.",
        annotations: READ,
        inputSchema: {},
      },
      async () => {
        const token = this.props.token;
        if (!token) {
          return { content: [{ type: "text" as const, text: NOT_SIGNED_IN }] };
        }
        const data = (await fasApi(this.env.API_BASE, "/v1/apps/mine", token)) as {
          apps?: Array<{ id: string; store: string; category: string; oneliner: string; appUrl: string; repoUrl: string }>;
          error?: string;
        };
        if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
        const apps = data.apps ?? [];
        if (apps.length === 0) return { content: [{ type: "text" as const, text: "No apps published yet." }] };
        const lines = apps.map(
          (a) => `- **${a.id}** (${a.category}) — ${a.oneliner}\n  Live: ${a.appUrl} | Repo: ${a.repoUrl}`
        );
        return { content: [{ type: "text" as const, text: `${apps.length} app(s):\n\n${lines.join("\n")}` }] };
      }
    );

    // ── deploy_status ──────────────────────────────────────────
    this.server.registerTool(
      "deploy_status",
      {
        title: "Check deploy status",
        description: "Show the last 5 GitHub Actions deploy runs for a FreeAppStore app, with status, commit and a link to each run.",
        annotations: READ,
        inputSchema: { app_id: z.string().describe("App ID (e.g. 'timer', 'pdfreader')") },
      },
      async ({ app_id }) => {
        const result = await getDeployStatus(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN);
        if ("error" in result) return toolError(`Error: ${result.error}`);
        const runs = result.runs;
        if (runs.length === 0) return txt(`No workflow runs found for ${app_id}.`);
        const lines = runs.map(
          (r) => `- ${r.status === "success" ? "✅" : r.status === "failure" ? "❌" : "⏳"} ${r.name} (${r.sha}) — ${r.updatedAt}\n  ${r.url}`
        );
        return { content: [{ type: "text" as const, text: `Deploy history for **${app_id}**:\n\n${lines.join("\n")}` }] };
      }
    );

    // ── app_info ───────────────────────────────────────────────
    this.server.registerTool(
      "app_info",
      {
        title: "Get app info",
        description: "Show a FreeAppStore app's live URL, repository and store listing, and whether the live site currently responds.",
        annotations: READ,
        inputSchema: { app_id: z.string().describe("App ID (e.g. 'timer', 'pdfreader')") },
      },
      async ({ app_id }) => {
        const domain = "freeappstore.online";
        const org = this.env.GITHUB_ORG;
        const liveUrl = `https://${app_id}.${domain}`;
        const repoUrl = `https://github.com/${org}/${app_id}`;
        const listingUrl = `https://${domain}/apps/${app_id}`;

        // Check if app is actually live
        const check = await fetch(liveUrl, { method: "HEAD" });
        const status = check.ok ? "Live (200)" : `Down (${check.status})`;

        return {
          content: [{
            type: "text" as const,
            text: [
              `**${app_id}**`,
              `Status: ${status}`,
              `Live: ${liveUrl}`,
              `Repo: ${repoUrl}`,
              `Listing: ${listingUrl}`,
              `Deploy: push to main auto-deploys via GitHub Actions → R2`,
            ].join("\n"),
          }],
        };
      }
    );

    // ── app_logs ──────────────────────────────────────────────
    this.server.registerTool(
      "app_logs",
      {
        title: "Read app logs",
        description: "Read recent runtime logs for an app you own: errors, warnings, SDK calls and build info.",
        annotations: READ,
        inputSchema: {
          app_id: z.string().describe("App ID"),
          level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Filter by log level"),
          limit: z.number().optional().describe("Max entries to return (default 50, max 500)"),
        },
      },
      async ({ app_id, level, limit }) => {
        const token = this.props.token;
        if (!token) {
          return { content: [{ type: "text" as const, text: NOT_SIGNED_IN }] };
        }
        const params = new URLSearchParams();
        if (level) params.set("level", level);
        params.set("limit", String(limit ?? 50));
        const data = (await fasApi(this.env.API_BASE, `/v1/apps/${app_id}/logs?${params}`, token)) as {
          logs?: Array<{ ts: number; level: string; category: string; message: string; data?: unknown; userId: string; build?: Record<string, unknown> }>;
          error?: string;
        };
        if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
        const logs = data.logs ?? [];
        if (logs.length === 0) return { content: [{ type: "text" as const, text: `No logs found for ${app_id}.` }] };
        const lines = logs.map(l => {
          const time = new Date(l.ts).toISOString().slice(11, 23);
          const data = l.data ? ` ${JSON.stringify(l.data)}` : "";
          return `${time} [${l.level.toUpperCase().padEnd(5)}] ${l.category}: ${l.message}${data}`;
        });
        // Include build info if present
        const buildEntry = logs.find(l => l.build);
        let buildInfo = "";
        if (buildEntry?.build) {
          const b = buildEntry.build;
          buildInfo = `\n\n**Build:** ${b.appVersion ?? "?"} (${(b.commitSha as string)?.slice(0, 7) ?? "?"}) built ${b.buildDate ?? "?"} | SDK ${b.sdkVersion ?? "?"} | ${b.viewport ?? "?"}`;
        }
        return { content: [{ type: "text" as const, text: `Logs for **${app_id}** (${logs.length} entries):${buildInfo}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`` }] };
      }
    );

    // ── platform_guide ─────────────────────────────────────────
    this.server.registerTool(
      "platform_guide",
      {
        title: "Get the platform guide",
        description: "Return the FreeAppStore platform guide (SKILLS.md): how apps are structured, built, checked and published, followed by the current app-building conventions.",
        annotations: READ,
        inputSchema: {},
      },
      async () => {
        const res = await fetch("https://freeappstore.online/skills.md");
        if (!res.ok) return txt(withBuildHandoff("Failed to fetch SKILLS.md"));
        return txt(withBuildHandoff(await res.text()));
      }
    );

    // ── sdk_reference ──────────────────────────────────────────
    this.server.registerTool(
      "sdk_reference",
      {
        title: "Look up the SDK reference",
        description: "Return reference documentation for @freeappstore/sdk, for one feature or all of them: shell (app frame and navigation), components (every UI component and its props), auth, KV, counters, collections, rooms, proxy, keys, push reminders, hooks and free APIs.",
        annotations: READ,
        inputSchema: { feature: z.enum(["all", ...SDK_REFERENCE_FEATURES]).optional().describe("Feature to look up, or 'all' for the full reference. 'shell' and 'components' cover app layout.") },
      },
      async ({ feature }) => txt(getSdkReference(feature)),
    );

    // ── create_app (provision + scaffold + go live) ────────────
    this.server.registerTool(
      "create_app",
      {
        title: "Create and publish an app",
        description: "Create and publish a new FreeAppStore app: provisions its GitHub repo, hosting and store listing (the same steps as `fas publish`), then scaffolds the current starter and pushes it. The first build rejects the untouched starter screen, so the app goes live only after `update_files` replaces it and a deploy succeeds (watch with `deploy_status`). The new app is public. If a run fails midway, call create_app again with the same app_id to resume. dry_run=true validates the inputs without creating anything.",
        annotations: WRITE,
        inputSchema: {
          app_id: z.string().describe("App slug: lowercase letters/numbers/hyphens, no 'free'/'pro' prefix. Becomes <app_id>.freeappstore.online"),
          category: z.string().describe("Learning, Strategy, Discovery, Brain Training, Social, Productivity, Health & Fitness, Finance, News & Weather, Utilities, or Other"),
          oneliner: z.string().describe("One-line description shown in the store"),
          type: z.enum(["standalone", "connected"]).optional().describe("standalone (no backend, default) or connected (uses the SDK: auth/kv/rooms/etc.)"),
          description: z.string().optional().describe("Longer description (defaults to the oneliner)"),
          dry_run: z.boolean().optional().describe("If true, validate inputs and return what would happen without actually creating the app"),
        },
      },
      async ({ app_id, category, oneliner, type, description, dry_run }) => {
        if (this.props.readOnly) return txt("Read-only mode is active. Write tools are disabled.");
        const token = this.props.token;
        if (!token) return txt(NOT_SIGNED_IN);
        const denied = await requirePermission(this.safety(), "write", "create_app", { app_id, category, type });
        if (denied) return denied;
        if (!this.env.GITHUB_TOKEN) return txt("Write tools are disabled (server missing GITHUB_TOKEN).");
        const kind = type ?? "standalone";
        auditLog("create_app", this.props.userId, { app_id, category, kind, dry_run: !!dry_run });
        const problems = createAppProblems(app_id);
        if (problems.length) return toolError(`Cannot create ${app_id}: ${problems.join("; ")}.`);
        if (dry_run) {
          await audit(this.safety(), { tool: "create_app", action: "dry_run", input: { app_id, category, kind } });
          return txt(
            `[DRY RUN] Would create **${app_id}** (${kind}):\n` +
            `- Provision: GitHub repo \`${this.env.GITHUB_ORG}/${app_id}\` + R2 hosting + store listing\n` +
            `- Scaffold: the current ${kind} starter, generated like \`fas init\` (identity set to ${app_id})\n` +
            `- Deploy: push to main → GitHub Actions. The first build rejects the untouched starter screen, so it stays red until update_files replaces it; the app is live only after a green deploy\n` +
            `- Build: wrap web/src/App.tsx in <Shell app={fas} nav={NAV}> with a nav item per screen, then write the screens\n` +
            `- Category: ${category}\n- Oneliner: ${oneliner}\n\nNo changes made. Remove dry_run to execute.\n\n${BUILD_HANDOFF_BLOCK}`,
          );
        }
        // 1. Provision via the same backend endpoint `fas publish` uses. It is idempotent for the
        //    app's own owner, so calling create_app again resumes a run that failed midway.
        const prov = (await fasPost(this.env.API_BASE, "/v1/publish", token, {
          name: app_id, store: "apps", category, type: kind, oneliner, description: description || oneliner,
        })) as { error?: string; detail?: string; appUrl?: string; repoUrl?: string };
        if (prov.error) return txt(`Provision failed: ${prov.error}${prov.detail ? ` — ${typeof prov.detail === "string" ? prov.detail : JSON.stringify(prov.detail)}` : ""}`);
        // 2. Scaffold the current starter and push it (only what the repo does not have yet).
        try {
          const plan = planScaffold(await listRepoFiles(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN));
          if (plan.action === "already-scaffolded") {
            return txt(`**${app_id}** already exists and has its deploy workflow, so nothing was overwritten. Use \`update_files\` to change it and \`deploy_status\` to watch it.`);
          }
          const files = buildScaffold(app_id, kind);
          for (const path of plan.skip) files.delete(path);
          const resumed = plan.skip.size > 0 ? " (resumed: files already in the repo were kept)" : "";
          await pushFiles(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN, files, `Initial ${app_id} — scaffolded via MCP`);
          await audit(this.safety(), { tool: "create_app", action: "success", input: { app_id, category, kind }, result: { url: `https://${app_id}.freeappstore.online` } });
          return txt(
            `Created **${app_id}** (${kind})${resumed}. It is NOT live yet.\n` +
            `The first build runs the starter-UI gate and will fail until update_files replaces the starter screen (web/src/App.tsx); the app is live at https://${app_id}.freeappstore.online only after a green deploy.\n` +
            `Repo: https://github.com/${this.env.GITHUB_ORG}/${app_id}\n` +
            `Listing (appears after the first successful deploy): https://freeappstore.online/apps/${app_id}\n\n` +
            `Scaffolded ${files.size} files. Next: \`list_files\`/\`read_file\` to inspect, \`update_files\` to build it out, \`deploy_status\` to watch it deploy.\n\n${BUILD_HANDOFF_BLOCK}`,
          );
        } catch (e) {
          return toolError(`Provisioned the repo + hosting, but the scaffold push failed: ${String(e)}\nNothing is lost: call create_app again with the same app_id to resume the scaffold.`);
        }
      },
    );

    // ── list_files ─────────────────────────────────────────────
    this.server.registerTool(
      "list_files",
      {
        title: "List app files",
        description: "List the files in a FreeAppStore app's repository.",
        annotations: READ,
        inputSchema: { app_id: z.string().describe("App ID") },
      },
      async ({ app_id }) => {
        const files = await listRepoFiles(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN);
        if (files.length === 0) return txt(`No files found for ${app_id} (repo empty or not found).`);
        return txt(`**${app_id}** — ${files.length} files:\n\n${files.map((f) => `- ${f}`).join("\n")}`);
      },
    );

    // ── read_file ──────────────────────────────────────────────
    this.server.registerTool(
      "read_file",
      {
        title: "Read an app file",
        description: "Read one file's contents from a FreeAppStore app's repository (e.g. web/src/App.tsx).",
        annotations: READ,
        inputSchema: { app_id: z.string().describe("App ID"), path: z.string().describe("File path relative to repo root, e.g. web/src/App.tsx") },
      },
      async ({ app_id, path }) => {
        const content = await readRepoFile(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN, path);
        if (content === null) return txt(`Could not read ${path} from ${app_id} (not found?).`);
        return txt(`\`\`\`\n${content}\n\`\`\``);
      },
    );

    // ── agent_build (delegate code-gen to the platform's VibeCode agent) ──
    this.server.registerTool(
      "agent_build",
      {
        title: "Build with the VibeCode agent",
        description: "Send a plain-English build request to FreeAppStore's VibeCode agent, which writes the code and deploys the app. It uses the AI key stored in your FreeAppStore key vault for the chosen provider. Runs in the background and returns a session_id to check with agent_status. Continuing a session can change files of that session's existing app.",
        annotations: OVERWRITE,
        inputSchema: {
          prompt: z.string().describe("What to build, in plain English. Include a desired app id, e.g. 'Build a dice roller and deploy it as dice-roller'."),
          provider: z.enum(["anthropic", "openai", "openrouter", "google"]).optional().describe("Which vaulted AI key to use (default anthropic). Must be a provider you have a key for."),
          model: z.string().optional().describe("Model id (defaults per provider, e.g. claude-sonnet-4-6)"),
          session_id: z.string().optional().describe("Continue an existing build session"),
        },
      },
      async ({ prompt, provider, model, session_id }) => {
        const token = this.props.token;
        if (!token) return txt(NOT_SIGNED_IN);
        const denied = await requirePermission(this.safety(), "runtime", "agent_build", { provider: provider ?? "anthropic" });
        if (denied) return denied;
        auditLog("agent_build", this.props.userId, { provider: provider ?? "anthropic" });
        await audit(this.safety(), { tool: "agent_build", action: "success", input: { provider: provider ?? "anthropic" } });
        const prov = provider ?? "anthropic";
        const defaultModel: Record<string, string> = {
          anthropic: "claude-sonnet-4-6",
          openai: "gpt-4o",
          openrouter: "anthropic/claude-sonnet-4",
          google: "gemini-2.0-flash",
        };
        // Force the session under the caller's namespace (see sessionPrefix):
        // a passed session_id is only honored if it's already in the caller's
        // namespace, otherwise it's re-scoped — so you can't target another
        // user's session id.
        const prefix = sessionPrefix(this.props.userId);
        const sid = session_id
          ? session_id.startsWith(prefix)
            ? session_id
            : prefix + session_id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)
          : prefix + crypto.randomUUID().slice(0, 12);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 110_000); // cap; build continues server-side
        let phases: string[] = [];
        let appId: string | null = null;
        let timedOut = false;
        let engineError: string | null = null;
        let transportError: string | null = null;
        try {
          const res = await fetch(`${this.env.AGENT_BASE}/session/${sid}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ message: prompt, aiConfig: { provider: prov, model: model ?? defaultModel[prov] ?? "claude-sonnet-4-6" } }),
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) {
            clearTimeout(timer);
            return txt(`Agent chat failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const p of parts) {
              const line = p.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              try {
                const ev = JSON.parse(line.slice(6));
                if (ev.type === "deploy" && ev.data) {
                  try { const d = JSON.parse(ev.data); if (d.phase) phases.push(d.phase); if (d.appId) appId = d.appId; } catch { /* */ }
                }
                if (ev.type === "error" && typeof ev.data === "string") engineError = ev.data.slice(0, 1000);
                if (ev.appId) appId = ev.appId;
              } catch { /* */ }
            }
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            timedOut = true; // aborted at the cap — the agent keeps building server-side
          } else {
            transportError = err instanceof Error ? err.message : String(err);
          }
        }
        clearTimeout(timer);
        if (engineError) return toolError(`Agent turn failed (session \`${sid}\`): ${engineError}\nCheck agent_status before retrying; the session may contain partial work.`);
        if (transportError) return toolError(`Could not confirm the agent turn result (session \`${sid}\`): ${transportError.slice(0, 500)}\nCheck agent_status before retrying.`);
        const last = phases[phases.length - 1];
        const liveLine = appId ? `Live (when built): https://${appId}.freeappstore.online` : "";
        return txt(
          `${timedOut ? "⏳ Agent still building" : "✓ Agent turn finished"} (session \`${sid}\`).\n` +
          (appId ? `App: **${appId}**\n` : "") +
          (last ? `Last deploy phase: ${last}\n` : "") +
          `${liveLine}\n\nPoll \`agent_status\` with session_id="${sid}" for progress + the live URL.`,
        );
      },
    );

    // ── agent_status ───────────────────────────────────────────
    this.server.registerTool(
      "agent_status",
      {
        title: "Check a VibeCode build",
        description: "Check a VibeCode agent build session (started with agent_build): active, deploying, failed, or idle status, app id, deploy phase, and live URL once ready.",
        annotations: READ,
        inputSchema: { session_id: z.string().describe("The session_id returned by agent_build") },
      },
      async ({ session_id }) => {
        const token = this.props.token;
        if (!token) return txt(NOT_SIGNED_IN);
        // Only let callers read sessions in their own namespace.
        if (!session_id.startsWith(sessionPrefix(this.props.userId)))
          return txt("That session isn't one of yours — agent sessions are scoped to your account. Use the session_id returned by agent_build.");
        const res = await fetch(`${this.env.AGENT_BASE}/session/${session_id}/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return txt(`Status fetch failed (${res.status}).`);
        const s = (await res.json()) as Parameters<typeof formatAgentStatus>[1];
        return txt(formatAgentStatus(session_id, s));
      },
    );

    // ── agent_activity (read your conversation with the build agent) ──
    this.server.registerTool(
      "agent_activity",
      {
        title: "Read a VibeCode session",
        description: "Read your VibeCode conversation with the build agent for a session: your prompts, the agent's replies, and its tool actions (file writes, compliance checks, deploys). Scoped to sessions you own — the backend rejects others. Get a session_id from agent_build, or from the Console URL /create/<id>.",
        annotations: READ,
        inputSchema: {
          session_id: z.string().describe("Session id — from agent_build, or the Console /create/<id> URL"),
          limit: z.number().int().min(1).max(200).optional().describe("Max recent messages to return (default 30)"),
        },
      },
      async ({ session_id, limit }) => {
        const token = this.props.token;
        if (!token) return txt(NOT_SIGNED_IN);
        const res = await fetch(`${this.env.AGENT_BASE}/session/${encodeURIComponent(session_id)}/history`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 403) return txt("That session isn't yours — agent sessions are scoped to your account.");
        if (res.status === 404 || res.status === 400) return txt(`No session "${session_id}" found.`);
        if (!res.ok) return txt(`History fetch failed (${res.status}).`);
        const data = (await res.json()) as {
          messages?: Array<{
            role: string;
            content: string;
            toolCalls?: Array<{ id?: string; name: string; input?: { path?: string; id?: string } }>;
            toolResults?: Array<{ id: string; content?: string; isError?: boolean }>;
          }>;
          appId?: string | null;
          appName?: string | null;
        };
        const msgs = data.messages ?? [];
        if (msgs.length === 0) return txt(`Session **${session_id}**${data.appId ? ` (${data.appId})` : ""}: no messages yet.`);
        return txt(formatAgentActivity(session_id, msgs, limit ?? 30, data.appName));
      },
    );

    // ── update_files (improve loop) ────────────────────────────
    this.server.registerTool(
      "update_files",
      {
        title: "Update app files",
        description: "Write or overwrite files in the repository of an app you own, each with its full new contents. The push deploys to <app_id>.freeappstore.online in about 30–60 seconds. dry_run=true checks ownership and lists the files without pushing.",
        annotations: OVERWRITE,
        inputSchema: {
          app_id: z.string().describe("App ID (must be one you published)"),
          files: z.array(z.object({ path: z.string(), content: z.string() })).describe("Files to write — each with the FULL new content. Paths relative to repo root, e.g. web/src/App.tsx"),
          message: z.string().optional().describe("Commit message"),
          dry_run: z.boolean().optional().describe("If true, validate ownership and list files that would be written without pushing"),
        },
      },
      async ({ app_id, files, message, dry_run }) => {
        const token = this.props.token;
        if (!token) return txt(NOT_SIGNED_IN);
        const denied = await requirePermission(this.safety(), "write", "update_files", { app_id, fileCount: files?.length ?? 0 });
        if (denied) return denied;
        if (!this.env.GITHUB_TOKEN) return txt("Write tools are disabled (server missing GITHUB_TOKEN).");
        if (!files?.length) return txt("No files provided.");
        const ownershipFailure = ownershipGateText(app_id, await ownsApp(this.env.API_BASE, token, app_id));
        if (ownershipFailure) return ownershipFailure.startsWith("Ownership check failed") ? toolError(ownershipFailure) : txt(ownershipFailure);
        auditLog("update_files", this.props.userId, { app_id, fileCount: files.length, dry_run: !!dry_run });
        // Check the app as it would be after the push, with the same shared preflight
        // VibeCode and `fas publish` run. dry_run reports the same findings.
        const org = this.env.GITHUB_ORG;
        const ghToken = this.env.GITHUB_TOKEN;
        let failures: string[];
        try {
          failures = await preflightUpdate(app_id, files, {
            paths: await listRepoFiles(org, app_id, ghToken),
            read: (path) => readRepoFile(org, app_id, ghToken, path),
            readBytes: (path) => readRepoBytes(org, app_id, ghToken, path),
          });
        } catch (e) {
          return toolError(`Could not check ${app_id} before pushing: ${String(e)}. Nothing was pushed.`);
        }
        const findings = failures.map((f) => `- ${f}`).join("\n");
        if (dry_run) {
          await audit(this.safety(), { tool: "update_files", action: "dry_run", input: { app_id, fileCount: files.length, preflightFailures: failures.length } });
          const listing = files.map((f) => `- ${f.path} (${f.content.length} chars)`).join("\n");
          return txt(
            `[DRY RUN] Would push ${files.length} file(s) to **${app_id}**:\n${listing}\n\n` +
            `Commit: ${message || `Update ${app_id} via MCP`}\n` +
            `Ownership: verified. Preflight: ${failures.length ? `WOULD BLOCK the push:\n${findings}` : "passed."}\n` +
            `No changes made. Remove dry_run to execute.`,
          );
        }
        if (failures.length) {
          await audit(this.safety(), { tool: "update_files", action: "denied", input: { app_id, fileCount: files.length, preflightFailures: failures.length } });
          return toolError(`Push to **${app_id}** refused: it would leave the app unable to build or deploy.\n${findings}\nFix these in the same update_files call, then push again.`);
        }
        const map = new Map(
          files.map((f) => [f.path, { content: textToB64(f.content), encoding: "base64" as const }]),
        );
        try {
          const sha = await pushFiles(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN, map, message || `Update ${app_id} via MCP`);
          await audit(this.safety(), { tool: "update_files", action: "success", input: { app_id, fileCount: files.length }, result: { sha: sha.slice(0, 7) } });
          return txt(`Pushed ${files.length} file(s) to **${app_id}** (${sha.slice(0, 7)}). Auto-deploying to https://${app_id}.freeappstore.online (~30-60s). Use deploy_status to watch.`);
        } catch (e) {
          return txt(`Push failed: ${String(e)}`);
        }
      },
    );
  }
}

// ── Auth middleware ─────────────────────────────────────────────
// OAuth 2.1 is handled by @cloudflare/workers-oauth-provider: it owns /token,
// /register (DCR), the discovery docs, and the 401 WWW-Authenticate challenge,
// and only forwards requests with a valid access token to the MCP apiHandler —
// where the granted props (set in auth-handler's completeAuthorization) arrive
// as `this.props`. The interactive login lives in AuthHandler (defaultHandler).
const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: FasMcpAgent.serve("/mcp"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [...MCP_SCOPES],
  // Keep MCP access grants aligned with the 30-day FAS session default.
  accessTokenTTL: MCP_ACCESS_TOKEN_TTL_SECONDS,
  // S256 only. The library accepts `plain` by default, which makes the
  // challenge equal to the verifier and PKCE decorative (#44).
  allowPlainPKCE: false,
});

// Every request is rate-limited per IP before the OAuth provider sees it (#68).
// Origin is checked outside the provider, which reflects any Origin itself (#524).
export default {
  fetch: withOriginCheck<Env>(
    withRateLimit<Env>((request, env, ctx) => withBoundedBody(request, (bounded) => oauthProvider.fetch(bounded, env, ctx))),
  ),
};
