import { useState, useEffect } from "react";
import { Nav } from "../components/Nav";
import { Markdown } from "../components/Markdown";
import { useAuth } from "../hooks/useAuth";
import { API_URL, getSession } from "../lib/api";

const ADMIN_API = "https://admin.freeappstore.online";
const ADMIN_ACCESS_MESSAGE = "Platform admin access required. Sign out and back in if your admin role was just added.";

function authHeaders(): Record<string, string> {
  const session = getSession();
  return session?.token
    ? { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

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

type Tab = "overview" | "apps" | "users" | "sessions" | "grants" | "creators";

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
  appUrl?: string;
  repo?: string;
  domain?: string;
  store?: string;
  hostedOn?: string;
  inRegistry?: boolean;
  owner?: string | null;
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
  deployState: { phase?: string } | null;
  updatedAt: number;
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

interface GrantUser {
  id: string;
  githubLogin: string;
  displayName: string | null;
  keys: { provider: string; label?: string | null }[];
  grant: { provider: string; model: string; expiresAt: string | null } | null;
}

export function Admin() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");

  if (loading)
    return (
      <>
        <Nav />
        <div className="container py-16 text-center" style={{ color: "var(--muted)" }}>
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
          <p style={{ color: "var(--muted)" }}>Admin access required.</p>
        </main>
      </>
    );

  return (
    <>
      <Nav />
      <main className="container py-6" style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <h1 className="text-2xl font-extrabold">Admin Dashboard</h1>
          <div className="flex gap-1 p-1 rounded-xl" style={{ background: "var(--panel)", border: "1px solid var(--line)" }}>
            {(["overview", "apps", "users", "sessions", "grants", "creators"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold capitalize"
                style={{
                  background: tab === t ? "var(--accent)" : "transparent",
                  color: tab === t ? "white" : "var(--muted)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {tab === "overview" && <OverviewTab />}
        {tab === "apps" && <AppsTab />}
        {tab === "users" && <UsersTab />}
        {tab === "sessions" && <SessionsTab />}
        {tab === "grants" && <GrantsTab />}
        {tab === "creators" && <CreatorsTab />}
      </main>
    </>
  );
}

// ── VibeCode Sessions Tab ──

function SessionsTab() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AgentSession | null>(null);

  useEffect(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "50" });
    if (search) params.set("q", search);
    adminFetchJson<{ sessions?: AgentSession[]; total?: number }>(`${API_URL}/v1/admin/agent-sessions?${params}`)
      .then((data) => {
        setSessions(data.sessions || []);
        setTotal(data.total || 0);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [search]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {total} total VibeCode sessions
        </p>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sessions..."
          className="p-2 rounded-lg border text-sm"
          style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)", width: 260 }}
        />
      </div>
      {error && <AdminAccessError message={error} />}
      {loading ? (
        <p style={{ color: "var(--muted)" }}>Loading sessions...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Session
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  User
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  App
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Status
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Updated
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId} style={{ borderBottom: "1px solid var(--line)" }}>
                  <td className="p-2">
                    <strong>{s.name}</strong>
                    <div className="text-xs font-mono" style={{ color: "var(--muted)" }}>
                      {s.sessionId}
                    </div>
                  </td>
                  <td className="p-2">
                    <strong className="text-sm">{s.userDisplayName || s.userLogin || s.userId}</strong>
                    <div className="text-xs font-mono" style={{ color: "var(--muted)" }}>
                      {s.userId}
                    </div>
                  </td>
                  <td className="p-2 text-xs">
                    {s.appUrl ? (
                      <a href={s.appUrl} target="_blank" style={{ color: "var(--accent)" }}>
                        {s.appId || s.appUrl}
                      </a>
                    ) : (
                      s.appId || "not deployed"
                    )}
                  </td>
                  <td className="p-2">
                    <StatusDot status={s.deployed ? "deployed" : s.deployState?.phase || "draft"} />
                  </td>
                  <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>
                    {timeAgo(s.updatedAt)}
                  </td>
                  <td className="p-2">
                    <button
                      onClick={() => setSelected(s)}
                      className="text-xs font-semibold px-2 py-1 rounded-md border"
                      style={{
                        color: "var(--accent)",
                        borderColor: "color-mix(in srgb, var(--accent) 35%, var(--line))",
                        background: "color-mix(in srgb, var(--accent) 8%, var(--panel))",
                        cursor: "pointer",
                      }}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sessions.length === 0 && (
            <p className="py-8 text-center" style={{ color: "var(--muted)" }}>
              No sessions found.
            </p>
          )}
        </div>
      )}
      {selected && <SessionInspectModal summary={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function SessionInspectModal({ summary, onClose }: { summary: AgentSession; onClose: () => void }) {
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

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="rounded-xl border"
        style={{
          width: "min(1100px, 100%)",
          maxHeight: "88vh",
          overflow: "hidden",
          background: "var(--paper)",
          borderColor: "var(--line)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.3)",
        }}
      >
        <div
          className="p-4 border-b flex items-start justify-between gap-3"
          style={{ borderColor: "var(--line)", background: "var(--panel)" }}
        >
          <div>
            <h3 className="font-bold text-lg">{detail?.name || summary.name}</h3>
            <div className="text-xs font-mono" style={{ color: "var(--muted)" }}>
              {sessionId}
            </div>
            <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              {userName} <span className="font-mono">{userId}</span>
              {detail?.appUrl || summary.appUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={detail?.appUrl || summary.appUrl || "#"} target="_blank" style={{ color: "var(--accent)" }}>
                    {detail?.appId || summary.appId || "live app"}
                  </a>
                </>
              ) : null}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-xl leading-none"
            style={{ color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}
          >
            x
          </button>
        </div>

        <div className="px-4 pt-3 flex gap-2 flex-wrap" style={{ background: "var(--paper)" }}>
          {(["transcript", "tools", "errors", "deploy"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setView(t)}
              className="px-3 py-1.5 rounded-lg text-sm font-semibold capitalize"
              style={{
                background: view === t ? "var(--accent)" : "var(--panel)",
                color: view === t ? "white" : "var(--muted)",
                border: "1px solid var(--line)",
                cursor: "pointer",
              }}
            >
              {t}
              {t === "errors" && errors.length ? ` (${errors.length})` : ""}
              {t === "tools" && toolMessages.length ? ` (${toolMessages.length})` : ""}
            </button>
          ))}
          <span className="text-xs self-center" style={{ color: "var(--success)" }}>
            ● live poll
          </span>
        </div>

        <div className="p-4" style={{ maxHeight: "64vh", overflow: "auto" }}>
          {loading && <p style={{ color: "var(--muted)" }}>Loading session...</p>}
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
              <p style={{ color: "var(--muted)" }}>No messages saved for this session yet.</p>
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
              <p style={{ color: "var(--muted)" }}>No tool calls/results saved yet.</p>
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
              <p style={{ color: "var(--success)" }}>No server-side errors for this session.</p>
            ))}
          {!loading &&
            !error &&
            view === "deploy" &&
            (deployLog.length ? (
              <div className="grid gap-3">
                {deployLog.map((entry, i) => (
                  <LogBlock
                    key={i}
                    tone={entry.phase === "error" ? "error" : "info"}
                    title={entry.phase || "deploy"}
                    time={entry.timestamp}
                    body={entry.detail || ""}
                  />
                ))}
              </div>
            ) : (
              <p style={{ color: "var(--muted)" }}>No deploy log entries saved yet.</p>
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
  const bg = isUser ? "color-mix(in srgb, var(--accent) 10%, var(--panel))" : isTool ? "var(--panel)" : "var(--paper)";
  const border = isUser ? "color-mix(in srgb, var(--accent) 30%, var(--line))" : "var(--line)";
  const toolCalls = message.toolCalls || [];
  const toolResults = message.toolResults || [];
  return (
    <div className="rounded-lg border p-3" style={{ background: bg, borderColor: border }}>
      <div
        className="text-xs font-bold uppercase mb-2"
        style={{ color: isTool ? "var(--warning)" : isUser ? "var(--accent)" : "var(--success)" }}
      >
        {title}
      </div>
      {message.content && (
        <div className="text-sm" style={{ color: "var(--ink)", lineHeight: 1.55 }}>
          {useMarkdown ? (
            <Markdown text={message.content} />
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>{message.content}</pre>
          )}
        </div>
      )}
      {toolCalls.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {toolCalls.map((tc, i) => (
            <code key={i} className="text-xs px-2 py-1 rounded-md" style={{ background: "var(--line)", color: "var(--ink)" }}>
              {tc.name || "tool"} {toolArg(tc.input)}
            </code>
          ))}
        </div>
      )}
      {toolResults.length > 0 && (
        <details open={forceExpanded} className="mt-3">
          <summary className="text-xs font-semibold" style={{ color: "var(--muted)", cursor: "pointer" }}>
            tool result{toolResults.length > 1 ? `s (${toolResults.length})` : ""}
          </summary>
          <div className="grid gap-2 mt-2">
            {toolResults.map((tr, i) => (
              <pre
                key={i}
                className="text-xs rounded-md p-2"
                style={{
                  whiteSpace: "pre-wrap",
                  maxHeight: 260,
                  overflow: "auto",
                  background: "var(--panel)",
                  color: "var(--muted)",
                  margin: 0,
                }}
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
      className="rounded-lg border p-3"
      style={{
        background: tone === "error" ? "color-mix(in srgb, var(--error) 8%, var(--panel))" : "var(--panel)",
        borderColor: tone === "error" ? "color-mix(in srgb, var(--error) 35%, var(--line))" : "var(--line)",
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <strong className="text-sm" style={{ color: tone === "error" ? "var(--error)" : "var(--accent)" }}>
          {title}
        </strong>
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          {formatDateTime(time)}
        </span>
      </div>
      <pre className="text-xs" style={{ whiteSpace: "pre-wrap", margin: 0, color: "var(--ink)" }}>
        {body}
      </pre>
    </div>
  );
}

// ── AI Grants Tab ──

function GrantsTab() {
  const [users, setUsers] = useState<GrantUser[]>([]);
  const [funded, setFunded] = useState<string[]>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [keyUser, setKeyUser] = useState<GrantUser | null>(null);
  const [keyProvider, setKeyProvider] = useState("anthropic");
  const [keyValue, setKeyValue] = useState("");
  const [keyMessage, setKeyMessage] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    setError("");
    Promise.all([
      adminFetchJson<{ users?: GrantUser[] }>(`${API_URL}/v1/admin/ai-grants/users`),
      adminFetchJson<{ funded?: string[] }>(`${API_URL}/v1/admin/ai-grants`),
    ])
      .then(([userData, grantData]) => {
        setUsers(userData.users || []);
        setFunded(grantData.funded || []);
        setSelectedUser((current) => current || userData.users?.[0]?.id || "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  async function saveGrant() {
    const isFunded = funded.includes(provider);
    const data = await adminFetchJson<{ error?: string; funded?: boolean }>(`${API_URL}/v1/admin/ai-grants`, {
      method: "POST",
      body: JSON.stringify({ userId: selectedUser, provider, model, note: null }),
    });
    if (data.error) alert(data.error);
    if (!isFunded || data.funded === false) {
      alert(`Grant saved, but ${provider} is not funded yet. Set COMP_KEY_${provider.toUpperCase()} on freeappstore-api for it to work.`);
    }
    load();
  }

  async function revoke(userId: string) {
    if (!confirm(`Revoke grant for ${userId}?`)) return;
    await adminFetchJson(`${API_URL}/v1/admin/ai-grants/delete`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    load();
  }

  function openKeyModal(user: GrantUser) {
    setKeyUser(user);
    setKeyProvider("anthropic");
    setKeyValue("");
    setKeyMessage("");
  }

  function closeKeyModal() {
    setKeyUser(null);
    setKeyValue("");
    setKeyMessage("");
    setKeySaving(false);
  }

  async function saveUserKey() {
    if (!keyUser) return;
    if (!keyValue.trim()) {
      setKeyMessage("Paste an API key first.");
      return;
    }
    setKeySaving(true);
    setKeyMessage("Saving...");
    try {
      await adminFetchJson(`${API_URL}/v1/admin/ai-keys`, {
        method: "POST",
        body: JSON.stringify({
          userId: keyUser.id,
          provider: keyProvider,
          key: keyValue.trim(),
          label: "Admin provisioned",
        }),
      });
      setKeyMessage(`Saved ${keyProvider} key.`);
      load();
      setTimeout(closeKeyModal, 700);
    } catch (e) {
      setKeyMessage(e instanceof Error ? e.message : String(e));
      setKeySaving(false);
    }
  }

  async function removeUserKey(userId: string, providerId: string) {
    if (!confirm(`Remove the ${providerId} key for ${userId}?`)) return;
    await adminFetchJson(`${API_URL}/v1/admin/ai-keys/delete`, {
      method: "POST",
      body: JSON.stringify({ userId, provider: providerId }),
    });
    load();
  }

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading grants...</p>;
  if (error) return <AdminAccessError message={error} />;

  return (
    <>
      <div className="p-4 rounded-xl border mb-5" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
        <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
          Funded providers: {funded.length ? funded.join(", ") : "none configured"}.
          {!funded.length && " Grants can be saved now, but they only run after the matching COMP_KEY secret is set."}
        </p>
        <div className="grid md:grid-cols-4 gap-2">
          <select
            value={selectedUser}
            onChange={(e) => setSelectedUser(e.target.value)}
            className="p-2 rounded-lg border text-sm"
            style={{ background: "var(--paper)", borderColor: "var(--line)" }}
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.githubLogin || u.id}
              </option>
            ))}
          </select>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(defaultGrantModel(e.target.value));
            }}
            className="p-2 rounded-lg border text-sm"
            style={{ background: "var(--paper)", borderColor: "var(--line)" }}
          >
            {["anthropic", "openai", "google"].map((p) => (
              <option key={p} value={p}>
                {p}
                {funded.includes(p) ? "" : " (unfunded)"}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="p-2 rounded-lg border text-sm"
            style={{ background: "var(--paper)", borderColor: "var(--line)" }}
          >
            {grantModelOptions(provider).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            onClick={saveGrant}
            disabled={!selectedUser || !provider || !model}
            className="px-3 py-2 rounded-lg text-sm font-semibold"
            style={{ background: "var(--accent)", color: "white", opacity: selectedUser && provider && model ? 1 : 0.5 }}
          >
            Save Grant
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--line)" }}>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                User
              </th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                Grant
              </th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                Vault Keys
              </th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: "1px solid var(--line)" }}>
                <td className="p-2">
                  <strong>{u.displayName || u.githubLogin || u.id}</strong>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>
                    {u.id}
                  </div>
                </td>
                <td className="p-2 text-xs">{u.grant ? `${u.grant.provider} / ${u.grant.model}` : "none"}</td>
                <td className="p-2 text-xs">
                  {u.keys.length ? (
                    <div className="flex flex-wrap gap-1">
                      {u.keys.map((k) => (
                        <span
                          key={k.provider}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border"
                          style={{
                            color: "var(--success)",
                            borderColor: "color-mix(in srgb, var(--success) 35%, var(--line))",
                            background: "color-mix(in srgb, var(--success) 10%, var(--panel))",
                          }}
                        >
                          {k.provider}
                          <button
                            onClick={() => removeUserKey(u.id, k.provider)}
                            title={`Remove ${k.provider} key`}
                            style={{
                              color: "var(--success)",
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: 0,
                              lineHeight: 1,
                            }}
                          >
                            x
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>none</span>
                  )}
                </td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => openKeyModal(u)}
                      className="text-xs font-semibold px-2 py-1 rounded-md border"
                      style={{
                        color: "var(--success)",
                        borderColor: "color-mix(in srgb, var(--success) 35%, var(--line))",
                        background: "color-mix(in srgb, var(--success) 10%, var(--panel))",
                        cursor: "pointer",
                      }}
                    >
                      Add Key
                    </button>
                    {u.grant && (
                      <button
                        onClick={() => revoke(u.id)}
                        className="text-xs font-semibold"
                        style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer" }}
                      >
                        Revoke Grant
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {keyUser && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) closeKeyModal();
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            className="rounded-xl border p-5"
            style={{
              width: "min(520px, 100%)",
              background: "var(--panel)",
              borderColor: "var(--line)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
            }}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 className="font-bold text-lg">Add AI Key</h3>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {keyUser.displayName || keyUser.githubLogin || keyUser.id} - {keyUser.id}
                </p>
              </div>
              <button
                onClick={closeKeyModal}
                className="text-xl leading-none"
                style={{ color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}
              >
                x
              </button>
            </div>
            <div className="grid gap-3">
              <select
                value={keyProvider}
                onChange={(e) => setKeyProvider(e.target.value)}
                className="p-2 rounded-lg border text-sm"
                style={{ background: "var(--paper)", borderColor: "var(--line)" }}
              >
                {keyProviderOptions().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <input
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                type="password"
                autoComplete="off"
                placeholder="Paste API key"
                className="p-2 rounded-lg border text-sm"
                style={{ background: "var(--paper)", borderColor: "var(--line)" }}
              />
              {keyMessage && (
                <p className="text-sm" style={{ color: keyMessage.includes("Saved") ? "var(--success)" : "var(--muted)" }}>
                  {keyMessage}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={closeKeyModal}
                  className="px-3 py-2 rounded-lg text-sm font-semibold border"
                  style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveUserKey}
                  disabled={keySaving || !keyValue.trim()}
                  className="px-3 py-2 rounded-lg text-sm font-semibold"
                  style={{ background: "var(--accent)", color: "white", opacity: keySaving || !keyValue.trim() ? 0.5 : 1 }}
                >
                  Save Key
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
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

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading stats...</p>;
  if (error || !stats) return <AdminAccessError message={error || "No stats returned"} />;

  const fasT = stats.traffic?.fas?.totals;

  return (
    <>
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
        <StatCard label="Apps" value={stats.apps} color="var(--accent)" />
        <StatCard label="Users" value={stats.users} color="#8b5cf6" />
        <StatCard label="Creators" value={stats.creators} color="#f59e0b" />
      </div>

      {/* Traffic */}
      <h2 className="text-lg font-bold mb-3">Traffic (30 days)</h2>
      <div className="grid grid-cols-1 gap-4 mb-8">
        <TrafficCard title="FreeAppStore" totals={fasT ?? null} days={stats.traffic?.fas?.days} />
      </div>
    </>
  );
}

function AdminAccessError({ message }: { message?: string }) {
  return (
    <div className="p-4 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
        {message || ADMIN_ACCESS_MESSAGE}
      </p>
      <a
        href="/profile"
        className="inline-flex px-3 py-2 rounded-lg text-sm font-semibold"
        style={{ background: "var(--accent)", color: "white" }}
      >
        Open Profile
      </a>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="p-5 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
      <div className="text-3xl font-extrabold mb-1" style={{ color }}>
        {value.toLocaleString()}
      </div>
      <div className="text-sm font-medium" style={{ color: "var(--muted)" }}>
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
      <div className="p-5 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
        <h3 className="font-bold mb-2">{title}</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          No traffic data
        </p>
      </div>
    );

  // Simple sparkline from daily data
  const dailyRequests = (days || []).map((d) => d.sum?.requests || 0);
  const max = Math.max(...dailyRequests, 1);
  const barWidth = 100 / Math.max(dailyRequests.length, 1);

  return (
    <div className="p-5 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
      <h3 className="font-bold mb-3">{title}</h3>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div>
          <div className="text-xl font-bold">{totals.visitors.toLocaleString()}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            Visitors
          </div>
        </div>
        <div>
          <div className="text-xl font-bold">{totals.pageViews.toLocaleString()}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            Page Views
          </div>
        </div>
        <div>
          <div className="text-xl font-bold">{formatNum(totals.requests)}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            Requests
          </div>
        </div>
      </div>
      {dailyRequests.length > 0 && (
        <div className="flex items-end gap-px" style={{ height: 48 }}>
          {dailyRequests.map((v: number, i: number) => (
            <div
              key={i}
              style={{ width: `${barWidth}%`, height: `${(v / max) * 100}%`, background: "var(--accent)", borderRadius: 2, minHeight: 2 }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Apps Tab ──

function AppsTab() {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [loadingApps, setLoadingApps] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoadingApps(true);
    setError(null);
    adminFetchJson<AdminApp[]>(`${ADMIN_API}/api/apps/all`)
      .then((all) => {
        setApps((Array.isArray(all) ? all : []).filter(isFreeAppStoreApp));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setApps([]);
      })
      .finally(() => setLoadingApps(false));
  }, []);

  async function handleUnpublish(id: string) {
    if (!confirm(`Remove "${id}" from the store?`)) return;
    try {
      const res = await fetch(`${ADMIN_API}/api/unpublish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id, store: "apps" }),
      });
      const data = await res.json();
      if (data.ok) setApps((prev) => prev.filter((a) => a.id !== id));
      else alert(data.error || "Failed");
    } catch (err) {
      alert(`Network error: ${err}`);
    }
  }

  async function handleDeprovision(id: string) {
    const deleteRepo = confirm(
      `DELETE "${id}" completely?\n\nThis will remove:\n- Custom domain\n- R2 hosting route\n- DNS record\n- Store registry entry\n\nClick OK to also delete the GitHub repo, or Cancel to keep it.`,
    );
    if (!confirm(`Are you sure you want to delete "${id}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${ADMIN_API}/api/deprovision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id, store: "apps", deleteRepo }),
      });
      const data = await res.json();
      if (data.ok) {
        setApps((prev) => prev.filter((a) => a.id !== id));
        alert(`Deleted "${id}":\n${data.steps.map((s: { name: string; status: string }) => `${s.name}: ${s.status}`).join("\n")}`);
      } else {
        alert(data.error || "Failed");
      }
    } catch (err) {
      alert(`Network error: ${err}`);
    }
  }

  const filtered = apps.filter(
    (a) => !search || a.name?.toLowerCase().includes(search.toLowerCase()) || a.id.includes(search.toLowerCase()),
  );

  return (
    <>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search apps..."
        aria-label="Search apps"
        className="w-full p-2 rounded-lg border mb-4"
        style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }}
      />
      {loadingApps ? (
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      ) : (
        <div className="overflow-x-auto">
          {error && (
            <p className="mb-3 text-sm" style={{ color: "var(--error)" }}>
              Failed to load apps: {error}
            </p>
          )}
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Name
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Hosting
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Registry
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Domain
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Updated
                </th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                  Links
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((app) => {
                const url = app.appUrl || (app.domain ? `https://${app.domain}` : "#");
                const repo = app.repo || `freeappstore-online/${app.id}`;
                return (
                  <tr key={app.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td className="p-2">
                      <strong>{app.name}</strong>
                      <div className="text-xs" style={{ color: "var(--muted)" }}>
                        {app.id}
                      </div>
                    </td>
                    <td className="p-2">
                      <StatusDot status={app.hostedOn === "r2" ? "active" : app.hostedOn || "unknown"} />
                    </td>
                    <td className="p-2">
                      <StatusDot status={app.inRegistry ? "active" : "unlisted"} />
                    </td>
                    <td className="p-2 text-xs font-mono" style={{ color: "var(--muted)" }}>
                      {app.domain || "—"}
                    </td>
                    <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>
                      {app.updatedAt ? timeAgo(app.updatedAt) : "—"}
                    </td>
                    <td className="p-2 flex gap-2 flex-wrap">
                      <a href={url} target="_blank" className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
                        Visit
                      </a>
                      <a
                        href={`https://github.com/${repo}`}
                        target="_blank"
                        className="text-xs font-semibold"
                        style={{ color: "var(--accent)" }}
                      >
                        Code
                      </a>
                      <button
                        onClick={() => handleUnpublish(app.id)}
                        className="text-xs font-semibold"
                        style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer" }}
                      >
                        Unpublish
                      </button>
                      <button
                        onClick={() => handleDeprovision(app.id)}
                        className="text-xs font-semibold"
                        style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer", opacity: 0.6 }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
            {filtered.length} of {apps.length} apps
          </p>
        </div>
      )}
    </>
  );
}

// ── Users Tab ──

function UsersTab() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    const offset = (page - 1) * 50;
    adminFetchJson<{ users?: Record<string, unknown>[]; total?: number }>(`${API_URL}/v1/admin/users?limit=50&offset=${offset}`)
      .then((data) => {
        setUsers(
          (data.users || []).map((u: Record<string, unknown>) => ({
            id: String(u.id || ""),
            email: String(u.email || ""),
            name: String(u.display_name || u.github_login || u.id || ""),
            photo_url: u.avatar_url ? String(u.avatar_url) : null,
            provider: String(u.provider || "github"),
            created_at: typeof u.created_at === "number" ? u.created_at : String(u.created_at || ""),
          })),
        );
        setTotal(data.total || 0);
        setPages(Math.max(1, Math.ceil((data.total || 0) / 50)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [page]);

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading users...</p>;
  if (error) return <AdminAccessError message={error} />;

  return (
    <>
      <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
        {total} total users
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--line)" }}>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                User
              </th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                Email
              </th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                Provider
              </th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>
                Joined
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: "1px solid var(--line)" }}>
                <td className="p-2 flex items-center gap-2">
                  {u.photo_url && <img src={u.photo_url} alt="" className="rounded-full" style={{ width: 28, height: 28 }} />}
                  <span className="font-medium">{u.name}</span>
                </td>
                <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>
                  {u.email}
                </td>
                <td className="p-2 text-xs">{u.provider}</td>
                <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>
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
            className="px-3 py-1 rounded-lg text-sm border"
            style={{
              borderColor: "var(--line)",
              background: "var(--panel)",
              color: "var(--ink)",
              cursor: page <= 1 ? "not-allowed" : "pointer",
              opacity: page <= 1 ? 0.5 : 1,
            }}
          >
            Prev
          </button>
          <span className="text-sm py-1" style={{ color: "var(--muted)" }}>
            {page} / {pages}
          </span>
          <button
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
            className="px-3 py-1 rounded-lg text-sm border"
            style={{
              borderColor: "var(--line)",
              background: "var(--panel)",
              color: "var(--ink)",
              cursor: page >= pages ? "not-allowed" : "pointer",
              opacity: page >= pages ? 0.5 : 1,
            }}
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
    fetch(`${ADMIN_API}/api/creators`, { credentials: "include" })
      .then((r) => r.json())
      .then(setCreators)
      .catch(() => {
        /* best-effort */
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading creators...</p>;

  return (
    <>
      <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
        {creators.length} creators
      </p>
      <div className="flex flex-col gap-3">
        {creators.map((c) => (
          <div key={c.github} className="p-4 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <a href={`https://github.com/${c.github}`} target="_blank" className="font-semibold" style={{ color: "var(--accent)" }}>
                  @{c.github}
                </a>
                {c.banned && (
                  <span
                    className="text-xs px-2 py-0.5 rounded-full font-semibold"
                    style={{ background: "color-mix(in srgb, var(--error) 15%, var(--panel))", color: "var(--error)" }}
                  >
                    Banned
                  </span>
                )}
              </div>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {c.apps.length} / {c.maxApps} slots
              </span>
            </div>
            {c.apps.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {c.apps.map((a) => (
                  <span key={a.id} className="text-xs px-2 py-1 rounded-lg" style={{ background: "var(--line)", color: "var(--ink)" }}>
                    {a.name} <span style={{ color: "var(--muted)" }}>({a.store})</span>
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
  const color = !status
    ? "var(--muted)"
    : ["active", "success", "completed", "deployed", "live", "ok"].includes(status)
      ? "var(--success)"
      : ["pending", "in_progress", "draft", "building", "pushing", "provisioning"].includes(status)
        ? "var(--warning)"
        : "var(--error)";
  return (
    <span style={{ color, fontSize: "0.9rem" }}>
      ●{" "}
      <span className="text-xs" style={{ color: "var(--muted)" }}>
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

function defaultGrantModel(provider: string): string {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  if (provider === "openai") return "gpt-4o";
  if (provider === "google") return "gemini-2.5-flash";
  return "claude-sonnet-4-6";
}

function grantModelOptions(provider: string): Array<{ value: string; label: string }> {
  if (provider === "anthropic")
    return [
      { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ];
  if (provider === "openai")
    return [
      { value: "gpt-4o", label: "GPT-4o" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini" },
      { value: "o4-mini", label: "o4 Mini" },
      { value: "o3", label: "o3" },
    ];
  if (provider === "google")
    return [
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ];
  return [{ value: defaultGrantModel(provider), label: defaultGrantModel(provider) }];
}

function keyProviderOptions(): Array<{ value: string; label: string }> {
  return [
    { value: "anthropic", label: "Anthropic" },
    { value: "openrouter", label: "OpenRouter" },
    { value: "openai", label: "OpenAI" },
    { value: "google-ai", label: "Google AI" },
  ];
}
