import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchTemplateFiles, listRepoFiles, pushFiles, readRepoFile, type RepoFile, textToB64 } from "./github.js";
import { AuthHandler } from "./auth-handler.js";
import { sessionPrefix, auditLog } from "./lib.js";
import { audit, listAuditEvents, MCP_SCOPES, requirePermission, type SafetyContext } from "./safety.js";

interface Env {
  API_BASE: string;
  GITHUB_ORG: string;
  AGENT_BASE: string;
  MCP_OBJECT: DurableObjectNamespace;
  GITHUB_TOKEN?: string;
  SESSION_SIGNING_KEY?: string;
  OAUTH_KV?: KVNamespace;
  /** When "1", all non-read tools are disabled server-wide. */
  MCP_READ_ONLY?: string;
}

// GitHub Actions API (public repos, no auth needed)
async function getDeployStatus(org: string, appId: string) {
  const res = await fetch(
    `https://api.github.com/repos/${org}/${appId}/actions/runs?per_page=5`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "freeappstore-mcp" } }
  );
  if (!res.ok) return { error: `GitHub API ${res.status}` };
  const data = (await res.json()) as {
    workflow_runs: Array<{
      name: string;
      conclusion: string | null;
      status: string;
      updated_at: string;
      html_url: string;
      head_sha: string;
    }>;
  };
  return (data.workflow_runs ?? []).map((r) => ({
    name: r.name,
    status: r.conclusion ?? r.status,
    updatedAt: r.updated_at,
    url: r.html_url,
    sha: r.head_sha?.slice(0, 7),
  }));
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

// Ownership gate for write tools: does the session user own this published app?
async function ownsApp(apiBase: string, token: string, appId: string): Promise<boolean> {
  const data = (await fasApi(apiBase, "/v1/apps/mine", token)) as { apps?: Array<{ id: string }>; error?: string };
  if (data.error) return false;
  return (data.apps ?? []).some((a) => a.id === appId);
}

const txt = (text: string) => ({ content: [{ type: "text" as const, text }] });

// sessionPrefix, auditLog, decodeUid are in lib.ts for testability.

export interface McpProps extends Record<string, unknown> {
  userId?: string;
  token?: string;
  readOnly?: boolean;
  /** MCP scopes granted by the OAuth token (null/undefined → all scopes). */
  scopes?: string[] | null;
}



export class FasMcpAgent extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "FreeAppStore",
    version: "0.2.0",
  });

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
    this.server.tool(
      "mcp_audit_log",
      "Read your recent MCP audit events for this account — every write/dry-run/denied tool action, newest first. User-scoped.",
      { limit: z.number().int().min(1).max(200).optional().describe("Max events to return (default 50)") },
      async ({ limit }) => {
        const denied = await requirePermission(this.safety(), "read", "mcp_audit_log", { limit });
        if (denied) return denied;
        return txt(JSON.stringify(await listAuditEvents(this.safety(), limit ?? 50), null, 2));
      },
    );

    // ── list_apps ──────────────────────────────────────────────
    this.server.tool(
      "list_apps",
      "List your published apps on FreeAppStore. Requires authentication (connect with a FAS session token).",
      {},
      async () => {
        const token = this.props.token;
        if (!token) {
          return { content: [{ type: "text" as const, text: "Not authenticated. Connect with a FAS session token to use this tool." }] };
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
    this.server.tool(
      "deploy_status",
      "Check the deploy status of an app (last 5 GitHub Actions runs). No auth needed for public repos.",
      { app_id: z.string().describe("App ID (e.g. 'timer', 'pdfreader')") },
      async ({ app_id }) => {
        const runs = await getDeployStatus(this.env.GITHUB_ORG, app_id);
        if ("error" in runs) return { content: [{ type: "text" as const, text: `Error: ${(runs as { error: string }).error}` }] };
        if ((runs as Array<unknown>).length === 0)
          return { content: [{ type: "text" as const, text: `No workflow runs found for ${app_id}.` }] };
        const lines = (runs as Array<{ name: string; status: string; updatedAt: string; sha: string; url: string }>).map(
          (r) => `- ${r.status === "success" ? "✅" : r.status === "failure" ? "❌" : "⏳"} ${r.name} (${r.sha}) — ${r.updatedAt}\n  ${r.url}`
        );
        return { content: [{ type: "text" as const, text: `Deploy history for **${app_id}**:\n\n${lines.join("\n")}` }] };
      }
    );

    // ── app_info ───────────────────────────────────────────────
    this.server.tool(
      "app_info",
      "Get info about any app on FreeAppStore — live URL, repo, store listing.",
      { app_id: z.string().describe("App ID (e.g. 'timer', 'pdfreader')") },
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
    this.server.tool(
      "app_logs",
      "Query recent logs for an app — errors, warnings, SDK calls, build info. Requires authentication (app owner).",
      {
        app_id: z.string().describe("App ID"),
        level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Filter by log level"),
        limit: z.number().optional().describe("Max entries to return (default 50, max 500)"),
      },
      async ({ app_id, level, limit }) => {
        const token = this.props.token;
        if (!token) {
          return { content: [{ type: "text" as const, text: "Not authenticated. Connect with a FAS session token to query logs." }] };
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
    this.server.tool(
      "platform_guide",
      "Get the FreeAppStore platform guide (SKILLS.md) for AI-assisted development. Returns the full guide that tells you how to build apps on the platform.",
      {},
      async () => {
        const res = await fetch("https://freeappstore.online/skills.md");
        if (!res.ok) return { content: [{ type: "text" as const, text: "Failed to fetch SKILLS.md" }] };
        const text = await res.text();
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── sdk_reference ──────────────────────────────────────────
    this.server.tool(
      "sdk_reference",
      "Quick reference for @freeappstore/sdk — imports, features, and usage patterns for auth, KV, counters, collections, rooms, proxy, hooks, and UI components.",
      { feature: z.enum(["all", "auth", "kv", "counters", "collections", "rooms", "proxy", "keys", "hooks", "ui", "free-apis"]).optional().describe("Specific feature to look up, or 'all' for the full reference") },
      async ({ feature }) => {
        const sections: Record<string, string> = {
          auth: `## Auth
\`\`\`tsx
import { initApp } from '@freeappstore/sdk'
const fas = initApp({ appId: 'my-app' })
// fas.auth.signIn()  — GitHub OAuth
// fas.auth.signOut()
// fas.auth.token     — current session token (string | null)
// fas.auth.user      — current user ({ id, login, avatarUrl } | null)
\`\`\``,
          kv: `## Per-user KV Storage
\`\`\`tsx
await fas.kv.set('key', { any: 'json' })
const val = await fas.kv.get('key')
await fas.kv.delete('key')
const keys = await fas.kv.list()                // all keys
const filtered = await fas.kv.list({ prefix: 'draft:' })
const many = await fas.kv.getMany(['k1', 'k2']) // batch read
\`\`\`
Limits: 1MB/user, 100 active users/day, 1k ops/min.`,
          counters: `## Shared Counters
\`\`\`tsx
const count = await fas.counters.get('likes')        // public, no auth
await fas.counters.increment('likes')                 // +1, requires auth
await fas.counters.increment('score', 10)             // +10
await fas.counters.increment('lives', -1)             // decrement
const all = await fas.counters.list()                 // all counters
const filtered = await fas.counters.list({ prefix: 'vote:' })
\`\`\`
Not user-scoped. Atomic. Use for votes, views, leaderboards.`,
          collections: `## Collections (Document Database)
\`\`\`tsx
const doc = await fas.collections.create('posts', { title: 'Hello', body: '...' })
const post = await fas.collections.get('posts', doc.id)
const all = await fas.collections.list('posts')
const mine = await fas.collections.list('posts', { mine: true })
await fas.collections.update('posts', doc.id, { title: 'Updated' })
await fas.collections.delete('posts', doc.id)
\`\`\`
Firestore-style. Public queryable JSON documents with ownership.`,
          rooms: `## Real-time Rooms (WebSocket)
\`\`\`tsx
const room = fas.rooms.join('my-room')
room.onMessage((msg) => console.log(msg.from.login, msg.data))
room.onPeers((peers) => console.log('peers:', peers))
room.onState((state) => console.log('connection:', state))
room.send({ type: 'move', x: 10, y: 20 })
room.leave()
\`\`\`
Limits: 5 rooms x 25 peers x 50 user-hours/day per app.`,
          proxy: `## Secret-injecting API Proxy
\`\`\`tsx
const weather = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London')
const data = await weather.json()
\`\`\`
Calls third-party APIs without exposing keys. Developer keys configured by platform admin, user keys stored in the key vault.`,
          keys: `## User API Key Vault
\`\`\`tsx
// Check if user has a key
const hasKey = await fas.keys.has('openai')

// Redirect to platform key management page
fas.keys.manage('openai')

// Check all configured providers
const keys = await fas.keys.status()
// [{ provider: 'openai', label: '...', createdAt: ..., lastUsedAt: ... }]
\`\`\`
Users store their API keys on the platform (encrypted AES-256-GCM). Apps never see plaintext keys. Use \`<KeyPrompt>\` component to prompt users when a key is missing. Supported providers: OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe.`,
          hooks: `## React Hooks
\`\`\`tsx
import { useAuth, useTheme } from '@freeappstore/sdk/hooks'

const { user, loading, signIn, signOut, deleteAccount } = useAuth(fas)
const { theme, preference, setPreference } = useTheme()
\`\`\``,
          ui: `## UI Components
\`\`\`tsx
import {
  FasShell, Avatar, SignInButton, ThemeToggle, ProfileMenu, ProfilePage,
  Spinner, Badge, Card, Tabs, Modal, ConfirmDialog, EmptyState,
  ProgressBar, SearchInput, ListRow, ErrorBoundary, KeyPrompt,
} from '@freeappstore/sdk/ui'

// Full app wrapper:
<FasShell app={fas} appName="My App" requireAuth>{children}</FasShell>

// Building blocks:
<Spinner size={24} />
<Badge variant="success">Live</Badge>
<Card onClick={handleClick}>content</Card>
<Tabs tabs={[{key:'a',label:'Tab A'},{key:'b',label:'Tab B'}]} active="a" onChange={setTab} />
<Modal open={isOpen} onClose={close} title="Settings">content</Modal>
<ConfirmDialog open={show} onConfirm={ok} onCancel={cancel} title="Delete?" message="Are you sure?" variant="danger" />
<EmptyState message="No items yet" action={<button>Add one</button>} />
<ProgressBar value={75} label="Upload" />
<SearchInput value={query} onChange={setQuery} />
<ListRow title="Item" subtitle="description" onClick={handleClick} />
<ErrorBoundary fallback={<p>Oops</p>}>{children}</ErrorBoundary>
<KeyPrompt app={fas} provider="openai" providerName="OpenAI" />
\`\`\``,
          "free-apis": `## Free Libraries & APIs (no key needed)

**Client-side libraries** (install and use directly):
- **Maps:** Leaflet + OpenStreetMap (\`pnpm add leaflet react-leaflet\`)
- **Charts:** Recharts (\`pnpm add recharts\`)
- **Rich text:** Tiptap (\`pnpm add @tiptap/react @tiptap/starter-kit\`)
- **Date/time:** date-fns (\`pnpm add date-fns\`)
- **Markdown:** react-markdown (\`pnpm add react-markdown\`)
- **PDF:** react-pdf or jsPDF (\`pnpm add @react-pdf/renderer\`)
- **QR codes:** qrcode.react (\`pnpm add qrcode.react\`)
- **Drag & drop:** dnd-kit (\`pnpm add @dnd-kit/core @dnd-kit/sortable\`)
- **Animations:** Framer Motion (\`pnpm add framer-motion\`)
- **Icons:** Lucide React (\`pnpm add lucide-react\`) — 1500+ icons
- **Forms:** React Hook Form (\`pnpm add react-hook-form\`)
- **State:** Zustand (\`pnpm add zustand\`)

**Free APIs** (no key, call directly from browser):
- Weather: Open-Meteo, Geocoding: Nominatim, Routing: OSRM
- Exchange rates: ExchangeRate-API, Countries: REST Countries
- Dictionary: dictionaryapi.dev, Hacker News: hn.algolia.com
- Wikipedia: MediaWiki API, Open Library: openlibrary.org
- Random users: randomuser.me, Images: picsum.photos

Prefer these before using the proxy. No key = no cost = no setup.`,
        };

        const selected = feature === "all" || !feature
          ? Object.values(sections).join("\n\n")
          : sections[feature] ?? `Unknown feature: ${feature}`;

        return { content: [{ type: "text" as const, text: `# @freeappstore/sdk Reference\n\n${selected}` }] };
      }
    );

    // ── create_app (provision + scaffold + go live) ────────────
    this.server.tool(
      "create_app",
      "Create AND publish a brand-new app on FreeAppStore, end to end. Provisions the GitHub repo + R2 hosting + store listing (same as `fas publish`), scaffolds the chosen template, and pushes it so the app deploys live at <app_id>.freeappstore.online (~1-2 min). Then use read_file/update_files to build it out. Requires authentication. Set dry_run=true to validate without creating.",
      {
        app_id: z.string().describe("App slug: lowercase letters/numbers/hyphens, no 'free'/'pro' prefix. Becomes <app_id>.freeappstore.online"),
        category: z.string().describe("Learning, Strategy, Discovery, Brain Training, Social, Productivity, Health & Fitness, Finance, News & Weather, Utilities, or Other"),
        oneliner: z.string().describe("One-line description shown in the store"),
        type: z.enum(["standalone", "connected"]).optional().describe("standalone (no backend, default) or connected (uses the SDK: auth/kv/rooms/etc.)"),
        description: z.string().optional().describe("Longer description (defaults to the oneliner)"),
        dry_run: z.boolean().optional().describe("If true, validate inputs and return what would happen without actually creating the app"),
      },
      async ({ app_id, category, oneliner, type, description, dry_run }) => {
        if (this.props.readOnly) return txt("Read-only mode is active. Write tools are disabled.");
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FAS session token to create apps.");
        const denied = await requirePermission(this.safety(), "write", "create_app", { app_id, category, type });
        if (denied) return denied;
        if (!this.env.GITHUB_TOKEN) return txt("Write tools are disabled (server missing GITHUB_TOKEN).");
        const kind = type ?? "standalone";
        auditLog("create_app", this.props.userId, { app_id, category, kind, dry_run: !!dry_run });
        if (dry_run) {
          await audit(this.safety(), { tool: "create_app", action: "dry_run", input: { app_id, category, kind } });
          return txt(
            `[DRY RUN] Would create **${app_id}** (${kind}):\n` +
            `- Provision: GitHub repo \`${this.env.GITHUB_ORG}/${app_id}\` + R2 hosting + store listing\n` +
            `- Scaffold: \`template-${kind}\` with APPNAME→${app_id} substitution\n` +
            `- Deploy: push to main → GitHub Actions → live at https://${app_id}.freeappstore.online\n` +
            `- Category: ${category}\n- Oneliner: ${oneliner}\n\nNo changes made. Remove dry_run to execute.`,
          );
        }
        // 1. Provision via the same backend endpoint `fas publish` uses.
        const prov = (await fasPost(this.env.API_BASE, "/v1/publish", token, {
          name: app_id, store: "apps", category, type: kind, oneliner, description: description || oneliner,
        })) as { error?: string; detail?: string; appUrl?: string; repoUrl?: string };
        if (prov.error) return txt(`Provision failed: ${prov.error}${prov.detail ? ` — ${typeof prov.detail === "string" ? prov.detail : JSON.stringify(prov.detail)}` : ""}`);
        // 2. Scaffold: fetch the template, substitute, push → triggers deploy.
        try {
          const templateRepo = kind === "connected" ? "template-connected" : "template-standalone";
          const files = await fetchTemplateFiles(this.env.GITHUB_ORG, templateRepo, this.env.GITHUB_TOKEN, app_id);
          await pushFiles(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN, files, `Initial ${app_id} — scaffolded via MCP`);
          await audit(this.safety(), { tool: "create_app", action: "success", input: { app_id, category, kind }, result: { url: `https://${app_id}.freeappstore.online` } });
          return txt(
            `Created **${app_id}** (${kind}).\n` +
            `Live in ~1-2 min: https://${app_id}.freeappstore.online\n` +
            `Repo: https://github.com/${this.env.GITHUB_ORG}/${app_id}\n` +
            `Listing: https://freeappstore.online/apps/${app_id}\n\n` +
            `Scaffolded ${files.size} files. Next: \`list_files\`/\`read_file\` to inspect, \`update_files\` to build it out, \`deploy_status\` to watch it deploy.`,
          );
        } catch (e) {
          return txt(`Provisioned the repo + hosting, but the scaffold push failed: ${String(e)}\nThe app exists — retry by pushing files with update_files.`);
        }
      },
    );

    // ── list_files ─────────────────────────────────────────────
    this.server.tool(
      "list_files",
      "List the files in an app's repo (so you know what to read/edit).",
      { app_id: z.string().describe("App ID") },
      async ({ app_id }) => {
        const files = await listRepoFiles(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN);
        if (files.length === 0) return txt(`No files found for ${app_id} (repo empty or not found).`);
        return txt(`**${app_id}** — ${files.length} files:\n\n${files.map((f) => `- ${f}`).join("\n")}`);
      },
    );

    // ── read_file ──────────────────────────────────────────────
    this.server.tool(
      "read_file",
      "Read one file's contents from an app's repo (e.g. web/src/App.tsx).",
      { app_id: z.string().describe("App ID"), path: z.string().describe("File path relative to repo root, e.g. web/src/App.tsx") },
      async ({ app_id, path }) => {
        const content = await readRepoFile(this.env.GITHUB_ORG, app_id, this.env.GITHUB_TOKEN, path);
        if (content === null) return txt(`Could not read ${path} from ${app_id} (not found?).`);
        return txt(`\`\`\`\n${content}\n\`\`\``);
      },
    );

    // ── agent_build (delegate code-gen to the platform's VibeCode agent) ──
    this.server.tool(
      "agent_build",
      "Hand a natural-language prompt to the FreeAppStore VibeCode AGENT — the platform's own AI writes the code AND deploys it. This is different from create_app/update_files (where the CALLING model writes the code): here you just prompt, and the platform builds. Uses your stored AI key (provider must be in your vault). Long-running; it builds in the background. Returns the session_id — poll agent_status to watch it and get the live URL. Tip: include the app id in your prompt, e.g. 'Build a dice roller and deploy it as dice-roller'.",
      {
        prompt: z.string().describe("What to build, in plain English. Include a desired app id."),
        provider: z.enum(["anthropic", "openai", "openrouter", "google"]).optional().describe("Which vaulted AI key to use (default anthropic). Must be a provider you have a key for."),
        model: z.string().optional().describe("Model id (defaults per provider, e.g. claude-sonnet-4-6)"),
        session_id: z.string().optional().describe("Continue an existing build session"),
      },
      async ({ prompt, provider, model, session_id }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FAS session token.");
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
                if (ev.appId) appId = ev.appId;
              } catch { /* */ }
            }
          }
        } catch {
          timedOut = true; // aborted at the cap — the agent keeps building server-side
        }
        clearTimeout(timer);
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
    this.server.tool(
      "agent_status",
      "Check a VibeCode agent build session (started with agent_build): the app id it's building, deploy phase, and live URL once ready.",
      { session_id: z.string().describe("The session_id returned by agent_build") },
      async ({ session_id }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FAS session token.");
        // Only let callers read sessions in their own namespace.
        if (!session_id.startsWith(sessionPrefix(this.props.userId)))
          return txt("That session isn't one of yours — agent sessions are scoped to your account. Use the session_id returned by agent_build.");
        const res = await fetch(`${this.env.AGENT_BASE}/session/${session_id}/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return txt(`Status fetch failed (${res.status}).`);
        const s = (await res.json()) as { appId?: string | null; appUrl?: string | null; deployStatus?: { phase?: string; error?: string } | null; messageCount?: number };
        const lines = [
          `Session **${session_id}**`,
          `App: ${s.appId ?? "(not deployed yet)"}`,
          `Deploy phase: ${s.deployStatus?.phase ?? "—"}${s.deployStatus?.error ? ` (error: ${s.deployStatus.error.slice(0, 200)})` : ""}`,
          s.appUrl ? `Live: ${s.appUrl}` : s.appId ? `URL (once live): https://${s.appId}.freeappstore.online` : "",
          `Messages: ${s.messageCount ?? 0}`,
        ].filter(Boolean);
        return txt(lines.join("\n"));
      },
    );

    // ── agent_activity (read your conversation with the build agent) ──
    this.server.tool(
      "agent_activity",
      "Read your VibeCode conversation with the build agent for a session: your prompts, the agent's replies, and its tool actions (file writes, compliance checks, deploys). Scoped to sessions you own — the backend rejects others. Get a session_id from agent_build, or from the Console URL /create/<id>.",
      {
        session_id: z.string().describe("Session id — from agent_build, or the Console /create/<id> URL"),
        limit: z.number().int().min(1).max(200).optional().describe("Max recent messages to return (default 30)"),
      },
      async ({ session_id, limit }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FAS session token.");
        const res = await fetch(`${this.env.AGENT_BASE}/session/${encodeURIComponent(session_id)}/history`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 403) return txt("That session isn't yours — agent sessions are scoped to your account.");
        if (res.status === 404 || res.status === 400) return txt(`No session "${session_id}" found.`);
        if (!res.ok) return txt(`History fetch failed (${res.status}).`);
        const data = (await res.json()) as {
          messages?: Array<{ role: string; content: string; toolCalls?: Array<{ name: string; input?: { path?: string; id?: string } }> }>;
          appId?: string | null;
          appName?: string | null;
        };
        const msgs = data.messages ?? [];
        if (msgs.length === 0) return txt(`Session **${session_id}**${data.appId ? ` (${data.appId})` : ""}: no messages yet.`);
        const recent = msgs.slice(-(limit ?? 30));
        const rendered = recent
          .map((m) => {
            if (m.toolCalls?.length) {
              const calls = m.toolCalls.map((tc) => `${tc.name}(${tc.input?.path ?? tc.input?.id ?? ""})`).join(", ");
              return `[agent → tools] ${calls}`;
            }
            if (m.role === "tool") return `[tool result] ${m.content.slice(0, 200)}`;
            return `**${m.role}:** ${m.content.slice(0, 1200)}`;
          })
          .join("\n\n");
        return txt(`Session **${session_id}**${data.appName ? ` — ${data.appName}` : ""} (${msgs.length} messages, showing ${recent.length}):\n\n${rendered}`);
      },
    );

    // ── update_files (improve loop) ────────────────────────────
    this.server.tool(
      "update_files",
      "Improve an app you own: write/overwrite one or more files in its repo with full new contents. The push auto-deploys to <app_id>.freeappstore.online in ~30-60s. Requires authentication + ownership. Set dry_run=true to validate without pushing.",
      {
        app_id: z.string().describe("App ID (must be one you published)"),
        files: z.array(z.object({ path: z.string(), content: z.string() })).describe("Files to write — each with the FULL new content. Paths relative to repo root, e.g. web/src/App.tsx"),
        message: z.string().optional().describe("Commit message"),
        dry_run: z.boolean().optional().describe("If true, validate ownership and list files that would be written without pushing"),
      },
      async ({ app_id, files, message, dry_run }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FAS session token.");
        const denied = await requirePermission(this.safety(), "write", "update_files", { app_id, fileCount: files?.length ?? 0 });
        if (denied) return denied;
        if (!this.env.GITHUB_TOKEN) return txt("Write tools are disabled (server missing GITHUB_TOKEN).");
        if (!files?.length) return txt("No files provided.");
        if (!(await ownsApp(this.env.API_BASE, token, app_id)))
          return txt(`You don't own "${app_id}" (or it isn't published). Only the owner can update it.`);
        auditLog("update_files", this.props.userId, { app_id, fileCount: files.length, dry_run: !!dry_run });
        if (dry_run) {
          await audit(this.safety(), { tool: "update_files", action: "dry_run", input: { app_id, fileCount: files.length } });
          const listing = files.map((f) => `- ${f.path} (${f.content.length} chars)`).join("\n");
          return txt(
            `[DRY RUN] Would push ${files.length} file(s) to **${app_id}**:\n${listing}\n\n` +
            `Commit: ${message || `Update ${app_id} via MCP`}\n` +
            `Ownership: verified. No changes made. Remove dry_run to execute.`,
          );
        }
        const map = new Map<string, RepoFile>(
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
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: FasMcpAgent.serve("/mcp"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [...MCP_SCOPES],
  accessTokenTTL: 86_400,
});
