import { useState, useEffect } from "react";
import { Nav } from "../components/Nav";
import { useAuth } from "../hooks/useAuth";

const ADMIN_API = "https://admin.freeappstore.online";

type Tab = "overview" | "apps" | "users" | "creators";

interface Stats {
  apps: number;
  games: number;
  users: number;
  creators: number;
  traffic: {
    fas: { totals: { requests: number; pageViews: number; visitors: number }; days: any[] } | null;
    fgs: { totals: { requests: number; pageViews: number; visitors: number }; days: any[] } | null;
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
            {(["overview", "apps", "users", "creators"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className="px-3 py-1.5 rounded-lg text-sm font-semibold capitalize" style={{ background: tab === t ? "var(--accent)" : "transparent", color: tab === t ? "white" : "var(--muted)", border: "none", cursor: "pointer" }}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {tab === "overview" && <OverviewTab />}
        {tab === "apps" && <AppsTab />}
        {tab === "users" && <UsersTab />}
        {tab === "creators" && <CreatorsTab />}
      </main>
    </>
  );
}

// ── Overview Tab ──

function OverviewTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${ADMIN_API}/api/stats`, { credentials: "include" })
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading stats...</p>;
  if (!stats) return <p style={{ color: "var(--error)" }}>Failed to load stats.</p>;

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
        <TrafficCard title="FreeAppStore" totals={fasT} days={stats.traffic?.fas?.days} />
        <TrafficCard title="FreeGameStore" totals={fgsT} days={stats.traffic?.fgs?.days} />
      </div>
    </>
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

function TrafficCard({ title, totals, days }: { title: string; totals: any; days: any[] | undefined }) {
  if (!totals) return (
    <div className="p-5 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
      <h3 className="font-bold mb-2">{title}</h3>
      <p className="text-sm" style={{ color: "var(--muted)" }}>No traffic data</p>
    </div>
  );

  // Simple sparkline from daily data
  const dailyRequests = (days || []).map((d: any) => d.sum?.requests || 0);
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
      .catch(() => {})
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
    const deleteRepo = confirm(`DELETE "${id}" completely?\n\nThis will remove:\n- Custom domain\n- CF Pages project\n- DNS record\n- Store registry entry\n\nClick OK to also delete the GitHub repo, or Cancel to keep it.`);
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
        alert(`Deleted "${id}":\n${data.steps.map((s: any) => `${s.name}: ${s.status}`).join("\n")}`);
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
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${store}...`} className="w-full p-2 rounded-lg border mb-4" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
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

  useEffect(() => {
    setLoading(true);
    fetch(`${ADMIN_API}/api/users?page=${page}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => { setUsers(data.users || []); setTotal(data.total || 0); setPages(data.pages || 1); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page]);

  if (loading) return <p style={{ color: "var(--muted)" }}>Loading users...</p>;

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
      .catch(() => {})
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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
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
