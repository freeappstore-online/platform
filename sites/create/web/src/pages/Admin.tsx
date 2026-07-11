import { useState, useEffect } from "react";
import { Nav } from "../components/Nav";
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
    const detail = typeof body === "object" && body && "error" in body
      ? String((body as { error?: unknown }).error)
      : text || res.statusText;
    throw new Error(`${url} returned ${res.status}: ${detail}`);
  }
  return body as T;
}

type Tab = "overview" | "apps" | "users" | "sessions" | "grants" | "creators";

interface Stats {
  apps: number;
  games: number;
  users: number;
  creators: number;
  traffic: {
    fas: { totals: { requests: number; pageViews: number; visitors: number }; days: { sum?: { requests?: number } }[] } | null;
    fgs: { totals: { requests: number; pageViews: number; visitors: number }; days: { sum?: { requests?: number } }[] } | null;
  } | null;
}

interface AppStatus {
  id: string;
  name: string;
  category?: string;
  appUrl?: string;
  repo?: string;
  domain?: string;
  cf?: { deploy: { status: string; time: string | null; url: string | null }; domain: { status: string } };
  gh?: { lastRun: string | null; pushed: string | null };
}

interface UserRecord {
  id: string;
  email: string;
  name: string;
  photo_url: string | null;
  provider: string;
  created_at: string;
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
  name: string;
  appId: string | null;
  appUrl: string | null;
  deployed: boolean;
  deployState: { phase?: string } | null;
  updatedAt: number;
}

interface GrantUser {
  id: string;
  githubLogin: string;
  displayName: string | null;
  keys: { provider: string }[];
  grant: { provider: string; model: string; expiresAt: string | null } | null;
}

export function Admin() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");

  if (loading) return <><Nav /><div className="container py-16 text-center" style={{ color: "var(--muted)" }}>Loading...</div></>;
  if (!user) return <><Nav /><main className="container py-16 text-center"><h1 className="text-3xl font-extrabold mb-3">Admin</h1><p style={{ color: "var(--muted)" }}>Admin access required.</p></main></>;

  return (
    <><Nav />
      <main className="container py-6" style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <h1 className="text-2xl font-extrabold">Admin Dashboard</h1>
          <div className="flex gap-1 p-1 rounded-xl" style={{ background: "var(--panel)", border: "1px solid var(--line)" }}>
            {(["overview", "apps", "users", "sessions", "grants", "creators"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className="px-3 py-1.5 rounded-lg text-sm font-semibold capitalize" style={{ background: tab === t ? "var(--accent)" : "transparent", color: tab === t ? "white" : "var(--muted)", border: "none", cursor: "pointer" }}>
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

  useEffect(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "50" });
    if (search) params.set("q", search);
    adminFetchJson<{ sessions?: AgentSession[]; total?: number }>(`${API_URL}/v1/admin/agent-sessions?${params}`)
      .then((data) => { setSessions(data.sessions || []); setTotal(data.total || 0); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [search]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <p className="text-sm" style={{ color: "var(--muted)" }}>{total} total VibeCode sessions</p>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sessions..." className="p-2 rounded-lg border text-sm" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)", width: 260 }} />
      </div>
      {error && <AdminAccessError message={error} />}
      {loading ? <p style={{ color: "var(--muted)" }}>Loading sessions...</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Session</th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>User</th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>App</th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Status</th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId} style={{ borderBottom: "1px solid var(--line)" }}>
                  <td className="p-2">
                    <strong>{s.name}</strong>
                    <div className="text-xs font-mono" style={{ color: "var(--muted)" }}>{s.sessionId}</div>
                  </td>
                  <td className="p-2 text-xs font-mono" style={{ color: "var(--muted)" }}>{s.userId}</td>
                  <td className="p-2 text-xs">{s.appUrl ? <a href={s.appUrl} target="_blank" style={{ color: "var(--accent)" }}>{s.appId || s.appUrl}</a> : s.appId || "not deployed"}</td>
                  <td className="p-2"><StatusDot status={s.deployed ? "deployed" : s.deployState?.phase || "draft"} /></td>
                  <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>{timeAgo(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sessions.length === 0 && <p className="py-8 text-center" style={{ color: "var(--muted)" }}>No sessions found.</p>}
        </div>
      )}
    </>
  );
}

// ── AI Grants Tab ──

function GrantsTab() {
  const [users, setUsers] = useState<GrantUser[]>([]);
  const [funded, setFunded] = useState<string[]>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [note, setNote] = useState("");
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
    const data = await adminFetchJson<{ error?: string }>(`${API_URL}/v1/admin/ai-grants`, {
      method: "POST",
      body: JSON.stringify({ userId: selectedUser, provider, model, note: note || null }),
    });
    if (data.error) alert(data.error);
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

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading grants...</p>;
  if (error) return <AdminAccessError message={error} />;

  return (
    <>
      <div className="p-4 rounded-xl border mb-5" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
        <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Funded providers: {funded.length ? funded.join(", ") : "none configured"}</p>
        <div className="grid md:grid-cols-5 gap-2">
          <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)} className="p-2 rounded-lg border text-sm" style={{ background: "var(--paper)", borderColor: "var(--line)" }}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.githubLogin || u.id}</option>)}
          </select>
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(defaultGrantModel(e.target.value)); }} className="p-2 rounded-lg border text-sm" style={{ background: "var(--paper)", borderColor: "var(--line)" }}>
            {["anthropic", "openai", "google"].map((p) => <option key={p} value={p}>{p}{funded.includes(p) ? "" : " (unfunded)"}</option>)}
          </select>
          <input value={model} onChange={(e) => setModel(e.target.value)} className="p-2 rounded-lg border text-sm" style={{ background: "var(--paper)", borderColor: "var(--line)" }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" className="p-2 rounded-lg border text-sm" style={{ background: "var(--paper)", borderColor: "var(--line)" }} />
          <button onClick={saveGrant} disabled={!funded.includes(provider)} className="px-3 py-2 rounded-lg text-sm font-semibold" style={{ background: "var(--accent)", color: "white", opacity: funded.includes(provider) ? 1 : 0.5 }}>Save Grant</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--line)" }}>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>User</th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Grant</th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Vault Keys</th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: "1px solid var(--line)" }}>
                <td className="p-2"><strong>{u.displayName || u.githubLogin || u.id}</strong><div className="text-xs" style={{ color: "var(--muted)" }}>{u.id}</div></td>
                <td className="p-2 text-xs">{u.grant ? `${u.grant.provider} / ${u.grant.model}` : "none"}</td>
                <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>{u.keys.length ? u.keys.map((k) => k.provider).join(", ") : "none"}</td>
                <td className="p-2">{u.grant && <button onClick={() => revoke(u.id)} className="text-xs font-semibold" style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer" }}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      .then((data) => setStats({
        apps: Number(data.apps || 0),
        games: 0,
        users: Number(data.users || 0),
        creators: 0,
        traffic: null,
      }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading stats...</p>;
  if (error || !stats) return <AdminAccessError message={error || "No stats returned"} />;

  const fasT = stats.traffic?.fas?.totals;
  const fgsT = stats.traffic?.fgs?.totals;

  return (
    <>
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Apps" value={stats.apps} color="var(--accent)" />
        <StatCard label="Games" value={stats.games} color="#10b981" />
        <StatCard label="Users" value={stats.users} color="#8b5cf6" />
        <StatCard label="Creators" value={stats.creators} color="#f59e0b" />
      </div>

      {/* Traffic */}
      <h2 className="text-lg font-bold mb-3">Traffic (30 days)</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <TrafficCard title="FreeAppStore" totals={fasT ?? null} days={stats.traffic?.fas?.days} />
        <TrafficCard title="FreeGameStore" totals={fgsT ?? null} days={stats.traffic?.fgs?.days} />
      </div>
    </>
  );
}

function AdminAccessError({ message }: { message?: string }) {
  return (
    <div className="p-4 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>{message || ADMIN_ACCESS_MESSAGE}</p>
      <a href="/profile" className="inline-flex px-3 py-2 rounded-lg text-sm font-semibold" style={{ background: "var(--accent)", color: "white" }}>
        Open Profile
      </a>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="p-5 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
      <div className="text-3xl font-extrabold mb-1" style={{ color }}>{value.toLocaleString()}</div>
      <div className="text-sm font-medium" style={{ color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

function TrafficCard({ title, totals, days }: { title: string; totals: { requests: number; pageViews: number; visitors: number } | null; days: { sum?: { requests?: number } }[] | undefined }) {
  if (!totals) return (
    <div className="p-5 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
      <h3 className="font-bold mb-2">{title}</h3>
      <p className="text-sm" style={{ color: "var(--muted)" }}>No traffic data</p>
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
          <div className="text-xs" style={{ color: "var(--muted)" }}>Visitors</div>
        </div>
        <div>
          <div className="text-xl font-bold">{totals.pageViews.toLocaleString()}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>Page Views</div>
        </div>
        <div>
          <div className="text-xl font-bold">{formatNum(totals.requests)}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>Requests</div>
        </div>
      </div>
      {dailyRequests.length > 0 && (
        <div className="flex items-end gap-px" style={{ height: 48 }}>
          {dailyRequests.map((v: number, i: number) => (
            <div key={i} style={{ width: `${barWidth}%`, height: `${(v / max) * 100}%`, background: "var(--accent)", borderRadius: 2, minHeight: 2 }} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Apps Tab ──

function AppsTab() {
  const [store, setStore] = useState<"apps" | "games">("apps");
  const [apps, setApps] = useState<AppStatus[]>([]);
  const [loadingApps, setLoadingApps] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoadingApps(true);
    fetch(`${ADMIN_API}/api/status?store=${store}`, { credentials: "include" })
      .then((r) => r.json())
      .then(setApps)
      .catch(() => { /* best-effort */ })
      .finally(() => setLoadingApps(false));
  }, [store]);

  async function handleUnpublish(id: string) {
    if (!confirm(`Remove "${id}" from the store?`)) return;
    try {
      const res = await fetch(`${ADMIN_API}/api/unpublish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id, store }),
      });
      const data = await res.json();
      if (data.ok) setApps((prev) => prev.filter((a) => a.id !== id));
      else alert(data.error || "Failed");
    } catch (err) {
      alert(`Network error: ${err}`);
    }
  }

  async function handleDeprovision(id: string) {
    const deleteRepo = confirm(`DELETE "${id}" completely?\n\nThis will remove:\n- Custom domain\n- R2 hosting route\n- DNS record\n- Store registry entry\n\nClick OK to also delete the GitHub repo, or Cancel to keep it.`);
    if (!confirm(`Are you sure you want to delete "${id}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${ADMIN_API}/api/deprovision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id, store, deleteRepo }),
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

  const filtered = apps.filter((a) => !search || a.name?.toLowerCase().includes(search.toLowerCase()) || a.id.includes(search.toLowerCase()));

  return (
    <>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setStore("apps")} className="px-3 py-1 rounded-full text-sm font-semibold" style={{ background: store === "apps" ? "var(--accent)" : "var(--panel)", color: store === "apps" ? "white" : "var(--muted)", border: "1px solid var(--line)" }}>Apps</button>
        <button onClick={() => setStore("games")} className="px-3 py-1 rounded-full text-sm font-semibold" style={{ background: store === "games" ? "var(--accent)" : "var(--panel)", color: store === "games" ? "white" : "var(--muted)", border: "1px solid var(--line)" }}>Games</button>
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${store}...`} aria-label={`Search ${store}`} className="w-full p-2 rounded-lg border mb-4" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
      {loadingApps ? <p style={{ color: "var(--muted)" }}>Loading...</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Name</th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Deploy</th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Domain</th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Last Push</th>
                <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Links</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((app) => {
                const url = app.appUrl || (app.domain ? `https://${app.domain}` : "#");
                const repo = app.repo || `${store === "apps" ? "freeappstore-online" : "freegamestore-online"}/${app.id}`;
                return (
                  <tr key={app.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td className="p-2"><strong>{app.name}</strong><div className="text-xs" style={{ color: "var(--muted)" }}>{app.id}</div></td>
                    <td className="p-2"><StatusDot status={app.cf?.deploy?.status} /></td>
                    <td className="p-2"><StatusDot status={app.cf?.domain?.status} /></td>
                    <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>{app.gh?.pushed ? timeAgo(app.gh.pushed) : "—"}</td>
                    <td className="p-2 flex gap-2 flex-wrap">
                      <a href={url} target="_blank" className="text-xs font-semibold" style={{ color: "var(--accent)" }}>Visit</a>
                      <a href={`https://github.com/${repo}`} target="_blank" className="text-xs font-semibold" style={{ color: "var(--accent)" }}>Code</a>
                      <button onClick={() => handleUnpublish(app.id)} className="text-xs font-semibold" style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer" }}>Unpublish</button>
                      <button onClick={() => handleDeprovision(app.id)} className="text-xs font-semibold" style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer", opacity: 0.6 }}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>{filtered.length} of {apps.length} {store}</p>
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
        setUsers((data.users || []).map((u: Record<string, unknown>) => ({
          id: String(u.id || ""),
          email: String(u.email || ""),
          name: String(u.display_name || u.github_login || u.id || ""),
          photo_url: u.avatar_url ? String(u.avatar_url) : null,
          provider: String(u.provider || "github"),
          created_at: String(u.created_at || ""),
        })));
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
      <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>{total} total users</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--line)" }}>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>User</th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Email</th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Provider</th>
              <th className="text-left p-2 font-semibold" style={{ color: "var(--muted)" }}>Joined</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: "1px solid var(--line)" }}>
                <td className="p-2 flex items-center gap-2">
                  {u.photo_url && <img src={u.photo_url} alt="" className="rounded-full" style={{ width: 28, height: 28 }} />}
                  <span className="font-medium">{u.name}</span>
                </td>
                <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>{u.email}</td>
                <td className="p-2 text-xs">{u.provider}</td>
                <td className="p-2 text-xs" style={{ color: "var(--muted)" }}>{new Date(u.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex gap-2 mt-4 justify-center">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 rounded-lg text-sm border" style={{ borderColor: "var(--line)", background: "var(--panel)", color: "var(--ink)", cursor: page <= 1 ? "not-allowed" : "pointer", opacity: page <= 1 ? 0.5 : 1 }}>Prev</button>
          <span className="text-sm py-1" style={{ color: "var(--muted)" }}>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="px-3 py-1 rounded-lg text-sm border" style={{ borderColor: "var(--line)", background: "var(--panel)", color: "var(--ink)", cursor: page >= pages ? "not-allowed" : "pointer", opacity: page >= pages ? 0.5 : 1 }}>Next</button>
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
      .catch(() => { /* best-effort */ })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading creators...</p>;

  return (
    <>
      <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>{creators.length} creators</p>
      <div className="flex flex-col gap-3">
        {creators.map((c) => (
          <div key={c.github} className="p-4 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <a href={`https://github.com/${c.github}`} target="_blank" className="font-semibold" style={{ color: "var(--accent)" }}>@{c.github}</a>
                {c.banned && <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: "color-mix(in srgb, var(--error) 15%, var(--panel))", color: "var(--error)" }}>Banned</span>}
              </div>
              <span className="text-xs" style={{ color: "var(--muted)" }}>{c.apps.length} / {c.maxApps} slots</span>
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
  const color = !status ? "var(--muted)" :
    ["active", "success", "completed"].includes(status) ? "var(--success)" :
    ["pending", "in_progress"].includes(status) ? "var(--warning)" : "var(--error)";
  return <span style={{ color, fontSize: "0.9rem" }}>● <span className="text-xs" style={{ color: "var(--muted)" }}>{status || "?"}</span></span>;
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

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function defaultGrantModel(provider: string): string {
  if (provider === "openai") return "gpt-4o";
  if (provider === "google") return "gemini-2.5-flash";
  return "claude-sonnet-4-6";
}
