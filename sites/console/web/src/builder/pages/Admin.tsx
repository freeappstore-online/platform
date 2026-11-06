import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Nav } from "../components/Nav";
import { Markdown } from "../components/Markdown";
import { useAuth } from "../hooks/useAuth";
import { API_URL, authHeaders } from "../lib/api";
import {
  buildFailingDeployRows,
  deployStatusForApp,
  githubActionsUrl,
  type AdminGithubDeployStatus,
  type FailingDeployRow,
} from "../lib/adminDeployFailures";
import { sortUsage, trendPercent, type SortDir, type UsagePoint, type UsageReport, type UsageSortKey } from "../lib/adminUsage";

const ADMIN_ACCESS_MESSAGE = "Platform admin access required. Sign out and back in if your admin role was just added.";
const ADMIN_WORKER_URL = "https://admin.freeappstore.online";

async function adminFetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    console.error("Admin API failed", { url, status: res.status, body });
    const detail =
      typeof body === "object" && body && "error" in body ? String((body as { error?: unknown }).error) : text || res.statusText;
    throw new Error(`${url} returned ${res.status}: ${detail}`);
  }
  return body as T;
}

type Tab = "overview" | "usage" | "apps" | "users" | "sessions" | "creators";

interface Stats {
  apps: number;
  users: number;
  creators: number;
  traffic: {
    fas: { totals: { requests: number; pageViews: number; visitors: number }; days: { sum?: { requests?: number } }[] } | null;
  } | null;
}

interface AdminApp {
  id: string;
  name: string;
  category?: string;
  type?: string | null;
  oneliner?: string | null;
  appUrl?: string;
  repo?: string;
  domain?: string;
  store?: string;
  hostedOn?: string;
  hasRoute?: boolean;
  r2Prefix?: string | null;
  inRegistry?: boolean;
  owner?: string | null;
  ownerDisplayName?: string | null;
  ownerAvatar?: string | null;
  sessionCount?: number;
  latestSession?: {
    sessionId?: string | null;
    name?: string | null;
    appUrl?: string | null;
    deployed?: boolean;
    deployState?: { phase?: string } | null;
    updatedAt?: number | null;
  } | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
}

interface UserRecord {
  id: string;
  email: string;
  name: string;
  photo_url: string | null;
  provider: string;
  created_at: string | number;
  /** VibeCode sessions and tokens per funding source (#16). */
  aiUsage: { source: string; sessions: number; inputTokens: number; outputTokens: number }[];
}

interface Creator {
  github: string;
  apps: { id: string; store: string; name: string; createdAt: string }[];
  banned: boolean;
  maxApps: number;
}

interface AgentSession {
  sessionId: string;
  userId: string;
  userLogin?: string | null;
  userDisplayName?: string | null;
  name: string;
  appId: string | null;
  appUrl: string | null;
  deployed: boolean;
  deployState: { phase?: string; error?: string | null } | null;
  repoUrl?: string | null;
  errorCount?: number;
  lastErrorSummary?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  aiProvider?: string | null;
  aiModel?: string | null;
  aiSource?: string | null;
  updatedAt: number;
}

/** What funded a VibeCode turn (#16), as the backend's `ai_source`. */
const AI_SOURCE_LABELS: Record<string, string> = {
  vault_user: "User key",
  vault_admin: "Admin key",
  grant: "Grant",
  grant_unfunded: "Grant (unfunded)",
  browser_key: "Browser key",
  none: "No key",
};

/** `?funded_by=` values the admin session/user lists accept. */
const FUNDED_BY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Any funding" },
  { value: "grant", label: "Grant" },
  { value: "admin_key", label: "Admin key" },
  { value: "user_key", label: "User key" },
  { value: "browser_key", label: "Browser key" },
  { value: "none", label: "No key" },
];

/** Server-side session filters (#15); each is a `?<key>=true` on /v1/admin/agent-sessions. */
const SESSION_FILTERS: { key: string; label: string; danger?: boolean }[] = [
  { key: "failed_deploy", label: "Failed deploys", danger: true },
  { key: "has_errors", label: "Has errors", danger: true },
  { key: "active_recently", label: "Active (24h)" },
  { key: "deployed", label: "Deployed" },
  { key: "draft", label: "Draft" },
];

function formatTokens(n: number | undefined): string {
  const v = n || 0;
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

/** Provider/model, funding source and token totals for one session (#16). */
function AiUsageCell({ session }: { session: Pick<AgentSession, "aiProvider" | "aiModel" | "aiSource" | "inputTokens" | "outputTokens"> }) {
  if (!session.aiSource && !session.aiProvider) return <span className="text-muted">—</span>;
  return (
    <>
      <strong className="text-xs">{session.aiSource ? AI_SOURCE_LABELS[session.aiSource] || session.aiSource : "—"}</strong>
      <div className="text-xs font-mono text-muted">
        {[session.aiProvider, session.aiModel].filter(Boolean).join(" · ") || "—"}
      </div>
      <div className="text-xs text-muted">
        {formatTokens(session.inputTokens)} in · {formatTokens(session.outputTokens)} out
      </div>
    </>
  );
}

interface AgentToolCall {
  name?: string;
  input?: Record<string, unknown>;
}

interface AgentToolResult {
  id?: string;
  content?: string;
}

interface AgentMessage {
  role?: string;
  content?: string;
  toolCalls?: AgentToolCall[];
  toolResults?: AgentToolResult[];
}

interface AgentErrorEntry {
  timestamp?: string;
  ts?: string | number;
  source?: string;
  message?: string;
}

interface AgentDeployLogEntry {
  timestamp?: string;
  phase?: string;
  detail?: string;
}

interface AgentSessionDetail extends Omit<AgentSession, "sessionId"> {
  id: string;
  sessionId?: string;
  messages: AgentMessage[];
  deployLog: AgentDeployLogEntry[];
  errors: AgentErrorEntry[];
  createdAt?: number;
}

interface AgentDeployFailure extends Pick<AgentSession, "sessionId" | "userId" | "name" | "appId" | "deployState" | "updatedAt"> {
  userLogin?: string | null;
  userDisplayName?: string | null;
  deployLog?: AgentDeployLogEntry[];
}

export function Admin() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  // Deep link from the session inspector (#15): which user the Users tab
  // should open on.
  const [focusUserId, setFocusUserId] = useState<string | null>(null);
  const openUser = (userId: string) => {
    setFocusUserId(userId);
    setTab("users");
  };

  if (loading)
    return (
      <>
        <Nav />
        <div className="container py-16 text-center text-muted">
          Loading...
        </div>
      </>
    );
  if (!user)
    return (
      <>
        <Nav />
        <main className="container py-16 text-center">
          <h1 className="text-3xl font-extrabold mb-3">Admin</h1>
          <p className="text-muted">Admin access required.</p>
        </main>
      </>
    );

  return (
    <>
      <Nav />
      <main className="container py-6 max-w-[1200px] m-[0_auto]">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <h1 className="text-2xl font-extrabold">Admin Dashboard</h1>
          <div className="flex gap-1 p-1 rounded-xl bg-panel border border-line">
            {(["overview", "usage", "apps", "users", "sessions", "creators"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold capitalize ${(tab === t ? "bg-accent" : "bg-transparent")} ${(tab === t ? "text-white" : "text-muted")} border-0 cursor-pointer`}

              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {tab === "overview" && <OverviewTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "apps" && <AppsTab />}
        {tab === "users" && <UsersTab focusUserId={focusUserId} onClearFocus={() => setFocusUserId(null)} />}
        {tab === "sessions" && <SessionsTab onOpenUser={openUser} />}
        {tab === "creators" && <CreatorsTab />}
      </main>
    </>
  );
}

// ── VibeCode Sessions Tab ──

function SessionsTab({ onOpenUser }: { onOpenUser: (userId: string) => void }) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<string[]>([]);
  const [fundedBy, setFundedBy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AgentSession | null>(null);

  useEffect(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "50" });
    if (search) params.set("q", search);
    if (fundedBy) params.set("funded_by", fundedBy);
    for (const f of filters) params.set(f, "true");
    adminFetchJson<{ sessions?: AgentSession[]; total?: number }>(`${API_URL}/v1/admin/agent-sessions?${params}`)
      .then((data) => {
        setSessions(data.sessions || []);
        setTotal(data.total || 0);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [search, fundedBy, filters]);

  const toggleFilter = (key: string) => setFilters((f) => (f.includes(key) ? f.filter((k) => k !== key) : [...f, key]));
  const filtered = filters.length > 0 || !!fundedBy || !!search;

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <p className="text-sm text-muted">
          {filtered ? `${total} matching VibeCode sessions` : `${total} total VibeCode sessions`}
        </p>
        <div className="flex gap-2 flex-wrap">
          {SESSION_FILTERS.map((f) => {
            const on = filters.includes(f.key);
            return (
              <button
                key={f.key}
                onClick={() => toggleFilter(f.key)}
                aria-pressed={on}
                className={`px-3 py-2 rounded-lg text-sm font-semibold border cursor-pointer ${on ? f.danger ? "bg-[color-mix(in_srgb,var(--danger)_15%,var(--panel))] border-danger text-danger" : "bg-[color-mix(in_srgb,var(--accent)_15%,var(--panel))] border-accent text-accent" : "bg-panel border-line text-muted"}`}
              >
                {f.label}
              </button>
            );
          })}
          <select
            value={fundedBy}
            onChange={(e) => setFundedBy(e.target.value)}
            aria-label="Funded by"
            className="p-2 rounded-lg border text-sm bg-panel border-line text-ink"
          >
            {FUNDED_BY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions..."
            className="p-2 rounded-lg border text-sm bg-panel border-line text-ink w-[260px]"
          />
        </div>
      </div>
      {error && <AdminAccessError message={error} />}
      {loading ? (
        <p className="text-muted">Loading sessions...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm [border-collapse:collapse]">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left p-2 font-semibold text-muted">
                  Session
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  User
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  App
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Status
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Last error
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  AI
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Updated
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId} className="border-b border-line">
                  <td className="p-2">
                    <strong>{s.name}</strong>
                    <div className="text-xs font-mono text-muted">
                      {s.sessionId}
                    </div>
                  </td>
                  <td className="p-2">
                    <strong className="text-sm">{s.userDisplayName || s.userLogin || s.userId}</strong>
                    <div className="text-xs font-mono text-muted">
                      {s.userId}
                    </div>
                  </td>
                  <td className="p-2 text-xs">
                    {s.appUrl ? (
                      <a href={s.appUrl} target="_blank" rel="noopener noreferrer" className="text-accent">
                        {s.appId || s.appUrl}
                      </a>
                    ) : (
                      s.appId || "not deployed"
                    )}
                  </td>
                  <td className="p-2">
                    <StatusDot status={s.deployed ? "deployed" : s.deployState?.phase || "draft"} />
                  </td>
                  <td className="p-2 text-xs max-w-[280px]">
                    {s.lastErrorSummary ? (
                      <span title={s.lastErrorSummary} className="text-danger">
                        {s.lastErrorSummary}
                        {(s.errorCount || 0) > 1 && <span className="text-muted"> · {s.errorCount} errors</span>}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="p-2">
                    <AiUsageCell session={s} />
                  </td>
                  <td className="p-2 text-xs text-muted">
                    {timeAgo(s.updatedAt)}
                  </td>
                  <td className="p-2">
                    <button
                      onClick={() => setSelected(s)}
                      className="text-xs font-semibold px-2 py-1 rounded-md border text-accent border-[color-mix(in_srgb,_var(--accent)_35%,_var(--line))] bg-[color-mix(in_srgb,_var(--accent)_8%,_var(--panel))] cursor-pointer"
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sessions.length === 0 && (
            <p className="py-8 text-center text-muted">
              {filtered ? "No sessions match these filters." : "No sessions found."}
            </p>
          )}
        </div>
      )}
      {selected && (
        <SessionInspectModal
          summary={selected}
          onClose={() => setSelected(null)}
          onOpenUser={(userId) => {
            setSelected(null);
            onOpenUser(userId);
          }}
        />
      )}
    </>
  );
}

function SessionInspectModal({
  summary,
  onClose,
  onOpenUser,
}: {
  summary: AgentSession;
  onClose: () => void;
  onOpenUser: (userId: string) => void;
}) {
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null);
  const [view, setView] = useState<"transcript" | "tools" | "errors" | "deploy">("transcript");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sessionId = summary.sessionId;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await adminFetchJson<{ session: AgentSessionDetail }>(
          `${API_URL}/v1/admin/agent-sessions/${encodeURIComponent(sessionId)}`,
        );
        if (!cancelled) {
          setDetail(data.session);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  const userName = detail?.userDisplayName || detail?.userLogin || summary.userDisplayName || summary.userLogin || summary.userId;
  const userId = detail?.userId || summary.userId;
  const messages = detail?.messages || [];
  const toolMessages = messages.filter(
    (m) => m.role === "tool" || m.role === "tool_result" || (m.toolCalls?.length || 0) > 0 || (m.toolResults?.length || 0) > 0,
  );
  const errors = detail?.errors || [];
  const deployLog = detail?.deployLog || [];
  const deployState = detail?.deployState || summary.deployState;
  const appId = detail?.appId || summary.appId;
  const appActionsUrl = githubActionsUrl(appId);
  const repoUrl = detail?.repoUrl || summary.repoUrl;
  const aiSource = detail?.aiSource ?? summary.aiSource;
  const linkButton = "text-accent bg-transparent border-0 p-0 cursor-pointer [font:inherit]";

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-[0px] bg-[rgba(0,0,0,0.5)] z-[60] flex items-center justify-center p-[16px]"
    >
      <div
        className="rounded-xl border w-[min(1100px,_100%)] max-h-[88vh] overflow-hidden bg-paper border-line shadow-[0_24px_80px_rgba(0,0,0,0.3)]"
      >
        <div
          className="p-4 border-b flex items-start justify-between gap-3 border-line bg-panel"
        >
          <div>
            <h3 className="font-bold text-lg">{detail?.name || summary.name}</h3>
            <div className="text-xs font-mono text-muted">
              {sessionId}
            </div>
            <div className="text-sm mt-1 text-muted">
              {userName} <span className="font-mono">{userId}</span>
              {detail?.appUrl || summary.appUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={detail?.appUrl || summary.appUrl || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent"
                  >
                    {appId || "live app"}
                  </a>
                </>
              ) : null}
              {appId ? (
                <>
                  {" "}
                  ·{" "}
                  <Link to={`/?app=${encodeURIComponent(appId)}`} className="text-accent">
                    Open in VibeCode
                  </Link>
                </>
              ) : null}
              {appActionsUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={appActionsUrl} target="_blank" rel="noopener noreferrer" className="text-accent">
                    GitHub Actions
                  </a>
                </>
              ) : null}
              {repoUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="text-accent">
                    Repo
                  </a>
                </>
              ) : null}
              {userId ? (
                <>
                  {" "}
                  ·{" "}
                  <button type="button" onClick={() => onOpenUser(userId)} className={linkButton}>
                    View user
                  </button>
                </>
              ) : null}
              {userId && aiSource?.startsWith("grant") ? (
                <>
                  {" "}
                  ·{" "}
                  {/* AI grants and keys are managed in the admin worker's AI Keys page (#528). */}
                  <a href={`${ADMIN_WORKER_URL}/#/ai-keys`} target="_blank" rel="noreferrer" className={linkButton}>
                    View grant
                  </a>
                </>
              ) : null}
            </div>
            <div className="mt-1">
              <AiUsageCell session={{ ...summary, ...(detail ?? {}) }} />
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-xl leading-none text-muted bg-transparent border-0 cursor-pointer"
          >
            x
          </button>
        </div>

        <div className="px-4 pt-3 flex gap-2 flex-wrap bg-paper">
          {(["transcript", "tools", "errors", "deploy"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setView(t)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold capitalize ${(view === t ? "bg-accent" : "bg-panel")} ${(view === t ? "text-white" : "text-muted")} border border-line cursor-pointer`}

            >
              {t}
              {t === "errors" && errors.length ? ` (${errors.length})` : ""}
              {t === "tools" && toolMessages.length ? ` (${toolMessages.length})` : ""}
            </button>
          ))}
          <span className="text-xs self-center text-success">
            ● live poll
          </span>
        </div>

        <div className="p-4 max-h-[64vh] overflow-auto">
          {loading && <p className="text-muted">Loading session...</p>}
          {error && <AdminAccessError message={error} />}
          {!loading &&
            !error &&
            view === "transcript" &&
            (messages.length ? (
              <div className="grid gap-3">
                {messages.map((m, i) => (
                  <AgentMessageBlock key={i} message={m} userName={userName} />
                ))}
              </div>
            ) : (
              <p className="text-muted">No messages saved for this session yet.</p>
            ))}
          {!loading &&
            !error &&
            view === "tools" &&
            (toolMessages.length ? (
              <div className="grid gap-3">
                {toolMessages.map((m, i) => (
                  <AgentMessageBlock key={i} message={m} userName={userName} forceExpanded />
                ))}
              </div>
            ) : (
              <p className="text-muted">No tool calls/results saved yet.</p>
            ))}
          {!loading &&
            !error &&
            view === "errors" &&
            (errors.length ? (
              <div className="grid gap-3">
                {errors.map((entry, i) => (
                  <LogBlock
                    key={i}
                    tone="error"
                    title={entry.source || "error"}
                    time={entry.timestamp || entry.ts}
                    body={entry.message || ""}
                  />
                ))}
              </div>
            ) : (
              <p className="text-success">No server-side errors for this session.</p>
            ))}
          {!loading &&
            !error &&
            view === "deploy" &&
            (deployLog.length || deployState ? (
              <div className="grid gap-3">
                {deployState && (
                  <div className="rounded-lg border p-3 bg-panel border-line">
                    <div className="text-xs font-bold uppercase mb-1 text-muted">
                      Final deploy phase
                    </div>
                    <StatusDot status={deployState.phase || "unknown"} />
                  </div>
                )}
                {deployLog.map((entry, i) => (
                  <LogBlock
                    key={i}
                    tone={entry.phase === "error" ? "error" : "info"}
                    title={entry.phase || "deploy"}
                    time={entry.timestamp}
                    body={entry.detail || ""}
                  />
                ))}
                {!deployLog.length && deployState?.phase === "error" && (
                  <LogBlock tone="error" title="Build failed" body={deployState.error || "No deploy error detail was saved."} />
                )}
              </div>
            ) : (
              <p className="text-muted">No deploy log entries saved yet.</p>
            ))}
        </div>
      </div>
    </div>
  );
}

function AgentMessageBlock({
  message,
  userName,
  forceExpanded = false,
}: {
  message: AgentMessage;
  userName: string;
  forceExpanded?: boolean;
}) {
  const role = message.role || "message";
  const isUser = role === "user";
  const isTool = role === "tool" || role === "tool_result";
  const useMarkdown = role === "assistant";
  const title = isUser ? userName : isTool ? "Tool" : role === "assistant" ? "AI" : role;

  const toolCalls = message.toolCalls || [];
  const toolResults = message.toolResults || [];
  return (
    <div className={`rounded-lg border p-3 ${isUser ? "bg-[color-mix(in_srgb,var(--accent)_10%,var(--panel))] border-[color-mix(in_srgb,var(--accent)_30%,var(--line))]" : isTool ? "bg-panel border-line" : "bg-paper border-line"}`}>
      <div
        className={`text-xs font-bold uppercase mb-2 ${(isTool ? "text-warning" : (isUser ? "text-accent" : "text-success"))}`}

      >
        {title}
      </div>
      {message.content && (
        <div className="text-sm text-ink leading-[1.55]">
          {useMarkdown ? (
            <Markdown text={message.content} />
          ) : (
            <pre className="[white-space:pre-wrap] m-[0px] font-[inherit]">{message.content}</pre>
          )}
        </div>
      )}
      {toolCalls.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {toolCalls.map((tc, i) => (
            <code key={i} className="text-xs px-2 py-1 rounded-md bg-line text-ink">
              {tc.name || "tool"} {toolArg(tc.input)}
            </code>
          ))}
        </div>
      )}
      {toolResults.length > 0 && (
        <details open={forceExpanded} className="mt-3">
          <summary className="text-xs font-semibold text-muted cursor-pointer">
            tool result{toolResults.length > 1 ? `s (${toolResults.length})` : ""}
          </summary>
          <div className="grid gap-2 mt-2">
            {toolResults.map((tr, i) => (
              <pre
                key={i}
                className="text-xs rounded-md p-2 [white-space:pre-wrap] max-h-[260px] overflow-auto bg-panel text-muted m-[0px]"
              >
                {tr.content || ""}
              </pre>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function LogBlock({ title, time, body, tone }: { title: string; time?: string | number; body: string; tone: "error" | "info" }) {
  return (
    <div
      className={`rounded-lg border p-3 ${(tone === "error" ? "bg-[color-mix(in_srgb,_var(--danger)_8%,_var(--panel))]" : "bg-panel")} ${(tone === "error" ? "border-[color-mix(in_srgb,_var(--danger)_35%,_var(--line))]" : "border-line")}`}

    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <strong className={`text-sm ${(tone === "error" ? "text-danger" : "text-accent")}`} >
          {title}
        </strong>
        <span className="text-xs text-muted">
          {formatDateTime(time)}
        </span>
      </div>
      <pre className="text-xs [white-space:pre-wrap] m-[0px] text-ink">
        {body}
      </pre>
    </div>
  );
}

// ── Overview Tab ──

function OverviewTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    adminFetchJson<Record<string, unknown>>(`${API_URL}/v1/admin/stats`)
      .then((data) =>
        setStats({
          apps: Number(data.apps || 0),
          users: Number(data.users || 0),
          creators: 0,
          traffic: null,
        }),
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-muted">Loading stats...</p>;
  if (error || !stats) return <AdminAccessError message={error || "No stats returned"} />;

  const fasT = stats.traffic?.fas?.totals;

  return (
    <>
      <FailingDeploysPanel />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
        <StatCard label="Apps" value={stats.apps} color="text-accent" />
        <StatCard label="Users" value={stats.users} color="text-(--pro)" />
        <StatCard label="Creators" value={stats.creators} color="text-warning" />
      </div>

      {/* Traffic */}
      <h2 className="text-lg font-bold mb-3">Traffic (30 days)</h2>
      <div className="grid grid-cols-1 gap-4 mb-8">
        <TrafficCard title="FreeAppStore" totals={fasT ?? null} days={stats.traffic?.fas?.days} />
      </div>
    </>
  );
}

function FailingDeploysPanel() {
  const [rows, setRows] = useState<FailingDeployRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [agentDeploys, ghStatuses, appsData] = await Promise.all([
        adminFetchJson<{ sessions?: AgentDeployFailure[] }>(`${API_URL}/v1/admin/agent-deploys?status=error&limit=200`),
        adminFetchJson<Record<string, AdminGithubDeployStatus>>(`${ADMIN_WORKER_URL}/api/apps/deploy-status`),
        adminFetchJson<{ apps?: AdminApp[] }>(`${API_URL}/v1/admin/apps`),
      ]);
      setRows(
        buildFailingDeployRows({
          sessions: agentDeploys.sessions || [],
          statuses: ghStatuses || {},
          apps: (appsData.apps || []).filter(isFreeAppStoreApp),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold">Failing Deploys</h2>
          <p className="text-sm text-muted">
            Apps and sessions whose latest deploy signal needs admin triage.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className={`px-3 py-2 rounded-lg text-sm font-semibold border bg-panel border-line text-ink ${(loading ? "[cursor:wait]" : "cursor-pointer")} ${(loading ? "opacity-[0.65]" : "opacity-[1]")}`}

        >
          Reload
        </button>
      </div>

      <div className="rounded-xl border overflow-hidden bg-panel border-line">
        {error ? (
          <div className="p-4">
            <p className="text-sm text-danger">
              Failed to load deploy failures: {error}
            </p>
          </div>
        ) : loading ? (
          <p className="p-4 text-sm text-muted">
            Loading deploy failures...
          </p>
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm [border-collapse:collapse]">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left p-2 font-semibold text-muted">
                    App
                  </th>
                  <th className="text-left p-2 font-semibold text-muted">
                    Owner
                  </th>
                  <th className="text-left p-2 font-semibold text-muted">
                    Error
                  </th>
                  <th className="text-left p-2 font-semibold text-muted">
                    Last failure
                  </th>
                  <th className="text-left p-2 font-semibold text-muted">
                    Run
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-line">
                    <td className="p-2">
                      {row.appUrl ? (
                        <a href={row.appUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent">
                          {row.appId}
                        </a>
                      ) : (
                        <strong>{row.appId}</strong>
                      )}
                      <div className="text-xs text-muted">
                        {row.appLabel}
                      </div>
                    </td>
                    <td className="p-2 text-xs font-mono text-muted">
                      {row.ownerLogin}
                    </td>
                    <td className="p-2">
                      <div className="text-danger">{row.errorSummary}</div>
                      {row.sessionId && (
                        <div className="text-xs font-mono text-muted">
                          {row.source === "github" ? "Session detail available" : row.sessionId}
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-xs text-muted">
                      {row.failedAt ? timeAgo(row.failedAt) : "unknown"}
                    </td>
                    <td className="p-2">
                      {row.actionsUrl ? (
                        <a href={row.actionsUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-accent">
                          Open Actions
                        </a>
                      ) : (
                        <span className="text-xs text-muted">
                          No app repo
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-4 text-sm text-success">
            No failing deploys found.
          </p>
        )}
      </div>
    </section>
  );
}

function AdminAccessError({ message }: { message?: string }) {
  return (
    <div className="p-4 rounded-xl border bg-panel border-line">
      <p className="text-sm mb-3 text-muted">
        {message || ADMIN_ACCESS_MESSAGE}
      </p>
      <Link
        to="/profile"
        className="inline-flex px-3 py-2 rounded-lg text-sm font-semibold bg-accent text-white"
      >
        Open Profile
      </Link>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="p-5 rounded-xl border bg-panel border-line">
      <div className={`text-3xl font-extrabold mb-1 ${color}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-sm font-medium text-muted">
        {label}
      </div>
    </div>
  );
}

function TrafficCard({
  title,
  totals,
  days,
}: {
  title: string;
  totals: { requests: number; pageViews: number; visitors: number } | null;
  days: { sum?: { requests?: number } }[] | undefined;
}) {
  if (!totals)
    return (
      <div className="p-5 rounded-xl border bg-panel border-line">
        <h3 className="font-bold mb-2">{title}</h3>
        <p className="text-sm text-muted">
          No traffic data
        </p>
      </div>
    );

  // Simple sparkline from daily data
  const dailyRequests = (days || []).map((d) => d.sum?.requests || 0);
  const max = Math.max(...dailyRequests, 1);

  return (
    <div className="p-5 rounded-xl border bg-panel border-line">
      <h3 className="font-bold mb-3">{title}</h3>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div>
          <div className="text-xl font-bold">{totals.visitors.toLocaleString()}</div>
          <div className="text-xs text-muted">
            Visitors
          </div>
        </div>
        <div>
          <div className="text-xl font-bold">{totals.pageViews.toLocaleString()}</div>
          <div className="text-xs text-muted">
            Page Views
          </div>
        </div>
        <div>
          <div className="text-xl font-bold">{formatNum(totals.requests)}</div>
          <div className="text-xs text-muted">
            Requests
          </div>
        </div>
      </div>
      {dailyRequests.length > 0 && (
        <svg className="w-full h-12" viewBox={` 0 0 ${dailyRequests.length * 10} 48`} preserveAspectRatio="none" role="img" aria-label="Daily requests">
          {dailyRequests.map((v, i) => {
            const barHeight = Math.max((v / max) * 48, 2);
            return <rect key={i} x={i * 10} y={48 - barHeight} width={9} height={barHeight} rx={2} className="fill-accent" />;
          })}
        </svg>
      )}
    </div>
  );
}

// ── Usage Tab ──
// Page views for every published app (#271), from GET /v1/analytics/admin/apps.

const USAGE_COLUMNS: Array<{ key: UsageSortKey; label: string; numeric: boolean }> = [
  { key: "id", label: "App", numeric: false },
  { key: "owner", label: "Owner", numeric: false },
  { key: "views", label: "Page views", numeric: true },
  { key: "unique_paths", label: "Unique paths", numeric: true },
  { key: "trend", label: "Trend", numeric: true },
];

function UsageTab() {
  const [days, setDays] = useState<7 | 30>(7);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] = useState<UsageSortKey>("views");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [onlyZero, setOnlyZero] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError("");
    adminFetchJson<UsageReport>(`${API_URL}/v1/analytics/admin/apps?days=${days}`)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [days]);

  const sortBy = (key: UsageSortKey, numeric: boolean) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir(numeric ? "desc" : "asc");
    }
  };

  const rows = report ? sortUsage(onlyZero ? report.apps.filter((a) => a.no_views) : report.apps, sortKey, sortDir) : [];

  return (
    <>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="text-lg font-bold">Usage across all apps</h2>
        <div className="flex gap-2 items-center">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${(days === d ? "bg-accent" : "bg-panel")} ${(days === d ? "text-white" : "text-muted")} border border-line cursor-pointer`}

            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-muted">Loading usage...</p>}
      {!loading && (error || !report) && <AdminAccessError message={error || "No usage returned"} />}

      {!loading && report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <StatCard label={`Page views (${report.days}d)`} value={report.totals.views} color="text-accent" />
            <StatCard label="Published apps" value={report.totals.apps} color="text-(--pro)" />
            <StatCard label="Apps with views" value={report.totals.apps_with_views} color="text-success" />
            <StatCard label="Apps with no views" value={report.totals.apps_without_views} color="text-warning" />
          </div>

          <div className="p-4 rounded-xl border mb-6 bg-panel border-line">
            <div className="text-sm font-semibold mb-2">Daily page views, all apps</div>
            <Sparkline series={report.totals.series} height={56} />
          </div>

          {report.totals.apps_without_views > 0 && (
            <p className="text-sm mb-3 text-muted">
              {report.totals.apps_without_views} app{report.totals.apps_without_views === 1 ? "" : "s"} recorded no page views in this window. That
              usually means the analytics loader (<code>/v1/analytics.js</code>) is missing from the app, or it isn't deployed.{" "}
              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={onlyZero} onChange={(e) => setOnlyZero(e.target.checked)} /> Show only these
              </label>
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  {USAGE_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={`${`p-2 font-semibold ${col.numeric ? "text-right" : "text-left"}`} text-muted`}

                      aria-sort={sortKey === col.key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <button
                        type="button"
                        onClick={() => sortBy(col.key, col.numeric)}
                        className="bg-transparent border-0 text-[inherit] [font:inherit] cursor-pointer p-[0px]"
                      >
                        {col.label}
                        {sortKey === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                      </button>
                    </th>
                  ))}
                  <th className="text-left p-2 font-semibold text-muted">
                    Daily
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b-2 border-line bg-panel">
                  <td className="p-2 font-bold">All apps</td>
                  <td className="p-2 text-muted">
                    {report.totals.apps} apps
                  </td>
                  <td className="p-2 text-right font-bold">{report.totals.views.toLocaleString()}</td>
                  <td className="p-2 text-right text-muted">
                    —
                  </td>
                  <td className="p-2 text-right">
                    <TrendBadge series={report.totals.series} />
                  </td>
                  <td className="p-2">
                    <Sparkline series={report.totals.series} height={20} />
                  </td>
                </tr>
                {rows.map((app) => (
                  <tr key={app.id} className="border-b border-line">
                    <td className="p-2">
                      <strong>{app.id}</strong>
                      {app.no_views && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-warning/15 text-warning">
                          no views
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-xs font-mono text-muted">
                      {app.owner}
                    </td>
                    <td className="p-2 text-right">{app.views.toLocaleString()}</td>
                    <td className="p-2 text-right text-muted">
                      {app.unique_paths.toLocaleString()}
                    </td>
                    <td className="p-2 text-right">
                      <TrendBadge series={app.series} />
                    </td>
                    <td className="p-2">
                      <Sparkline series={app.series} height={20} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted">
            Page views come from the cookieless platform loader. It stores no visitor identifier, so there is no unique-visitor
            count; unique paths is the closest measure. Trend compares the second half of the window with the first.
          </p>
          {report.unregistered.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              Views under app ids that aren't registered:{" "}
              {report.unregistered.map((u) => `${u.id} (${u.views.toLocaleString()})`).join(", ")}
            </p>
          )}
        </>
      )}
    </>
  );
}

export function Sparkline({ series, height }: { series: UsagePoint[]; height: number }) {
  const max = Math.max(...series.map((p) => p.views), 1);
  const total = series.reduce((sum, p) => sum + p.views, 0);
  return (
    <svg className="w-full min-w-20" height={height} viewBox={`0 0 ${Math.max(series.length, 1) * 10} ${height}`} preserveAspectRatio="none"
      role="img" aria-label={`${total.toLocaleString()} page views over ${series.length} days`}>
      {series.map((p, i) => {
        const barHeight = Math.max((p.views / max) * height, 1);
        return <rect key={p.t} x={i * 10} y={height - barHeight} width={9} height={barHeight} rx={1} className="fill-accent">
          <title>{p.t}: {p.views.toLocaleString()}</title>
        </rect>;
      })}
    </svg>
  );
}

function TrendBadge({ series }: { series: UsagePoint[] }) {
  const pct = trendPercent(series);
  if (pct === null)
    return (
      <span className="text-xs text-muted">
        —
      </span>
    );
  const color = pct > 0 ? "text-success" : pct < 0 ? "text-danger" : "text-muted";
  return (
    <span className={`text-xs font-semibold ${color}`}>
      {pct > 0 ? "▲" : pct < 0 ? "▼" : ""} {Math.abs(pct)}%
    </span>
  );
}

// ── Apps Tab ──

function AppsTab() {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [deployStatuses, setDeployStatuses] = useState<Record<string, AdminGithubDeployStatus>>({});
  const [loadingApps, setLoadingApps] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoadingApps(true);
    setError(null);
    Promise.all([
      adminFetchJson<{ apps?: AdminApp[] }>(`${API_URL}/v1/admin/apps`),
      adminFetchJson<Record<string, AdminGithubDeployStatus>>(`${ADMIN_WORKER_URL}/api/apps/deploy-status`).catch(() => ({})),
    ])
      .then(([data, statuses]) => {
        setApps((data.apps || []).filter(isFreeAppStoreApp));
        setDeployStatuses(statuses);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setApps([]);
        setDeployStatuses({});
      })
      .finally(() => setLoadingApps(false));
  }, []);

  const filtered = apps.filter(
    (a) =>
      !search ||
      a.name?.toLowerCase().includes(search.toLowerCase()) ||
      a.id.includes(search.toLowerCase()) ||
      a.owner?.toLowerCase().includes(search.toLowerCase()) ||
      a.domain?.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search apps..."
        aria-label="Search apps"
        className="w-full p-2 rounded-lg border mb-4 bg-panel border-line text-ink"
      />
      {loadingApps ? (
        <p className="text-muted">Loading...</p>
      ) : (
        <div className="overflow-x-auto">
          {error && (
            <p className="mb-3 text-sm text-danger">
              Failed to load apps: {error}
            </p>
          )}
          <table className="w-full text-sm [border-collapse:collapse]">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left p-2 font-semibold text-muted">
                  Name
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Owner
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Hosting
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Sessions
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Domain
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Updated
                </th>
                <th className="text-left p-2 font-semibold text-muted">
                  Links
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((app) => {
                const url = app.appUrl || (app.domain ? `https://${app.domain}` : "#");
                const repoUrl = githubRepoUrl(app.repo, app.id);
                const latestPhase = deployStatusForApp(app, deployStatuses);
                return (
                  <tr key={app.id} className="border-b border-line">
                    <td className="p-2">
                      <strong>{app.name}</strong>
                      <div className="text-xs text-muted">
                        {app.id}
                      </div>
                    </td>
                    <td className="p-2">
                      <strong className="text-sm">{app.ownerDisplayName || app.owner || "—"}</strong>
                      {app.ownerDisplayName && app.owner && (
                        <div className="text-xs font-mono text-muted">
                          {app.owner}
                        </div>
                      )}
                    </td>
                    <td className="p-2">
                      <StatusDot status={app.hasRoute === false ? "missing route" : app.hostedOn === "r2" ? "active" : app.hostedOn || "unknown"} />
                    </td>
                    <td className="p-2">
                      <StatusDot status={latestPhase} />
                      <div className="text-xs text-muted">
                        {app.sessionCount || 0} total
                      </div>
                    </td>
                    <td className="p-2 text-xs font-mono text-muted">
                      {app.domain || "—"}
                    </td>
                    <td className="p-2 text-xs text-muted">
                      {app.updatedAt ? timeAgo(app.updatedAt) : "—"}
                    </td>
                    <td className="p-2 flex gap-2 flex-wrap">
                      <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-accent">
                        Visit
                      </a>
                      <a
                        href={repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-semibold text-accent"
                      >
                        Code
                      </a>
                      <Link to={`/?app=${encodeURIComponent(app.id)}`} className="text-xs font-semibold text-accent">
                        Open in VibeCode
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-sm text-muted">
            {filtered.length} of {apps.length} apps
          </p>
        </div>
      )}
    </>
  );
}

// ── Users Tab ──

function UsersTab({ focusUserId, onClearFocus }: { focusUserId: string | null; onClearFocus: () => void }) {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [fundedBy, setFundedBy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    const offset = (page - 1) * 50;
    const funded = fundedBy ? `&funded_by=${encodeURIComponent(fundedBy)}` : "";
    const focus = focusUserId ? `&user=${encodeURIComponent(focusUserId)}` : "";
    adminFetchJson<{ users?: Record<string, unknown>[]; total?: number }>(`${API_URL}/v1/admin/users?limit=50&offset=${offset}${funded}${focus}`)
      .then((data) => {
        setUsers(
          (data.users || []).map((u: Record<string, unknown>) => ({
            id: String(u.id || ""),
            email: String(u.email || ""),
            name: String(u.display_name || u.github_login || u.id || ""),
            photo_url: u.avatar_url ? String(u.avatar_url) : null,
            provider: String(u.provider || "github"),
            created_at: typeof u.created_at === "number" ? u.created_at : String(u.created_at || ""),
            aiUsage: Array.isArray(u.aiUsage) ? (u.aiUsage as UserRecord["aiUsage"]) : [],
          })),
        );
        setTotal(data.total || 0);
        setPages(Math.max(1, Math.ceil((data.total || 0) / 50)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [page, fundedBy, focusUserId]);

  if (loading) return <p className="text-muted">Loading users...</p>;
  if (error) return <AdminAccessError message={error} />;

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <p className="text-sm text-muted">
          {focusUserId ? (
            <>
              Showing <span className="font-mono">{focusUserId}</span> ·{" "}
              <button type="button" onClick={onClearFocus} className="text-accent bg-transparent border-0 p-[0px] cursor-pointer [font:inherit]">
                Show all users
              </button>
            </>
          ) : (
            `${total} ${fundedBy ? "matching" : "total"} users`
          )}
        </p>
        <select
          value={fundedBy}
          onChange={(e) => {
            setPage(1);
            setFundedBy(e.target.value);
          }}
          aria-label="Funded by"
          className="p-2 rounded-lg border text-sm bg-panel border-line text-ink"
        >
          {FUNDED_BY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm [border-collapse:collapse]">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left p-2 font-semibold text-muted">
                User
              </th>
              <th className="text-left p-2 font-semibold text-muted">
                Email
              </th>
              <th className="text-left p-2 font-semibold text-muted">
                Provider
              </th>
              <th className="text-left p-2 font-semibold text-muted">
                AI usage
              </th>
              <th className="text-left p-2 font-semibold text-muted">
                Joined
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-line">
                <td className="p-2 flex items-center gap-2">
                  {u.photo_url && <img src={u.photo_url} alt="" className="rounded-full w-[28px] h-[28px]"  />}
                  <span className="font-medium">{u.name}</span>
                </td>
                <td className="p-2 text-xs text-muted">
                  {u.email}
                </td>
                <td className="p-2 text-xs">{u.provider}</td>
                <td className="p-2 text-xs">
                  {u.aiUsage.length
                    ? u.aiUsage.map((a) => (
                        <div key={a.source}>
                          <strong>{AI_SOURCE_LABELS[a.source] || a.source}</strong>{" "}
                          <span className="text-muted">
                            {a.sessions} session{a.sessions === 1 ? "" : "s"} · {formatTokens(a.inputTokens)} in / {formatTokens(a.outputTokens)} out
                          </span>
                        </div>
                      ))
                    : <span className="text-muted">—</span>}
                </td>
                <td className="p-2 text-xs text-muted">
                  {formatDate(u.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex gap-2 mt-4 justify-center">
          <button
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className={`px-3 py-1 rounded-lg text-sm border border-line bg-panel text-ink ${(page <= 1 ? "[cursor:not-allowed]" : "cursor-pointer")} ${(page <= 1 ? "opacity-[0.5]" : "opacity-[1]")}`}

          >
            Prev
          </button>
          <span className="text-sm py-1 text-muted">
            {page} / {pages}
          </span>
          <button
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
            className={`px-3 py-1 rounded-lg text-sm border border-line bg-panel text-ink ${(page >= pages ? "[cursor:not-allowed]" : "cursor-pointer")} ${(page >= pages ? "opacity-[0.5]" : "opacity-[1]")}`}

          >
            Next
          </button>
        </div>
      )}
    </>
  );
}

// ── Creators Tab ──

function CreatorsTab() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetchJson<Creator[]>(`${API_URL}/v1/admin/creators`)
      .then(setCreators)
      .catch(() => {
        /* best-effort */
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-muted">Loading creators...</p>;

  return (
    <>
      <p className="text-sm mb-4 text-muted">
        {creators.length} creators
      </p>
      <div className="flex flex-col gap-3">
        {creators.map((c) => (
          <div key={c.github} className="p-4 rounded-xl border bg-panel border-line">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <a href={`https://github.com/${c.github}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent">
                  @{c.github}
                </a>
                {c.banned && (
                  <span
                    className="text-xs px-2 py-0.5 rounded-full font-semibold bg-[color-mix(in_srgb,_var(--danger)_15%,_var(--panel))] text-danger"
                  >
                    Banned
                  </span>
                )}
              </div>
              <span className="text-xs text-muted">
                {c.apps.length} / {c.maxApps} slots
              </span>
            </div>
            {c.apps.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {c.apps.map((a) => (
                  <span key={a.id} className="text-xs px-2 py-1 rounded-lg bg-line text-ink">
                    {a.name} <span className="text-muted">({a.store})</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ── Shared helpers ──

function StatusDot({ status }: { status: string | undefined }) {
  const normalized = status?.toLowerCase();
  const color = !normalized
    ? "text-muted"
    : ["active", "success", "completed", "deployed", "live", "ok"].includes(normalized)
      ? "text-success"
      : ["pending", "in_progress", "queued", "waiting", "draft", "building", "pushing", "provisioning", "unknown", "none", "not deployed", "cancelled"].includes(
            normalized,
          )
        ? "text-warning"
        : "text-danger";
  return (
    <span className={`text-[0.9rem] ${color}`}>
      ●{" "}
      <span className="text-xs text-muted">
        {status || "?"}
      </span>
    </span>
  );
}

function isFreeAppStoreApp(app: AdminApp): boolean {
  const store = (app.store || "").toLowerCase();
  const domain = (app.domain || app.appUrl || "").toLowerCase();
  return store === "apps" || store === "fas" || domain.includes(".freeappstore.online") || domain.endsWith("freeappstore.online");
}

function githubRepoUrl(repo: string | null | undefined, id: string): string {
  if (!repo) return `https://github.com/freeappstore-online/${id}`;
  if (/^https?:\/\//i.test(repo)) return repo;
  return `https://github.com/${repo.replace(/^\/+/, "")}`;
}

function timeAgo(value: string | number): string {
  const then = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function parseTime(value: string | number | undefined): number {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return new Date(value).getTime();
}

function formatDate(value: string | number | undefined): string {
  const time = parseTime(value);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString() : "—";
}

function formatDateTime(value: string | number | undefined): string {
  const time = parseTime(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "—";
}

function toolArg(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const value = input.path || input.id || input.name || input.url || input.pattern;
  return typeof value === "string" ? value : "";
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
