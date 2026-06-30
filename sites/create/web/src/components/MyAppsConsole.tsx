import { useEffect, useState } from "react";
import type { Project } from "../hooks/useProjects";
import { useAppStatuses, type DevStatus } from "../hooks/useAppStatuses";

export function MyAppsConsole({ projects, loading, error, onRetry, currentId, onSelect, onNewChat }: {
  projects: Project[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  currentId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"edited" | "name">(() => (localStorage.getItem("fas_apps_sort") as "edited" | "name") || "edited");
  useEffect(() => { localStorage.setItem("fas_apps_sort", sort); }, [sort]);
  const statuses = useAppStatuses(projects.map((p) => p.id));

  const q = search.toLowerCase();
  const sorter = (a: Project, b: Project) =>
    sort === "name" ? a.name.localeCompare(b.name) : (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const filtered = projects
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.appId?.toLowerCase().includes(q))
    .slice()
    .sort(sorter);

  const deployed = filtered.filter((p) => p.deployed);
  const drafts = filtered.filter((p) => !p.deployed);

  return (
    <div className="flex-1 overflow-y-auto" style={{ overflowX: "hidden" }}>
      <div className="container py-6" style={{ maxWidth: 720 }}>
        {/* Header — "My Apps" is a section label under the Free Apps brand, so keep it modest */}
        <div className="flex items-center justify-between gap-2 mb-5">
          <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>My Apps</h1>
          <button
            onClick={onNewChat}
            title="New app"
            aria-label="New app"
            className="rounded-lg font-semibold text-white inline-flex items-center justify-center gap-1.5 shrink-0"
            style={{ background: "var(--accent)", border: "none", cursor: "pointer", minHeight: 40, padding: "0 0.85rem", fontSize: "0.9rem" }}
          >
            <span aria-hidden style={{ fontSize: "1.1rem", lineHeight: 1 }}>+</span>
            <span className="hidden sm:inline">New App</span>
          </button>
        </div>

        {/* Search + sort */}
        <div className="mb-5 flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps..."
            className="flex-1 p-3 rounded-xl border text-sm"
            style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }}
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as "edited" | "name")}
            aria-label="Sort apps"
            className="rounded-xl border text-sm px-3"
            style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }}
          >
            <option value="edited">Last edited</option>
            <option value="name">Name</option>
          </select>
        </div>

        {loading && (
          <div className="text-center py-12">
            <div className="inline-block w-6 h-6 border-2 rounded-full animate-spin mb-3" style={{ borderColor: "var(--line)", borderTopColor: "var(--accent)" }} />
            <p className="text-sm" style={{ color: "var(--muted)" }}>Loading your apps…</p>
          </div>
        )}

        {/* Load failure — reassure, don't imply data loss */}
        {!loading && error && projects.length === 0 && (
          <div className="text-center py-12">
            <p className="text-sm font-semibold mb-1">Couldn't load your apps</p>
            <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
              Your apps are safe on the server — this was a connection issue.
            </p>
            <button onClick={onRetry} className="px-5 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: "var(--accent)", border: "none", cursor: "pointer" }}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && projects.length <= 1 && !projects[0]?.deployed && (
          <div className="text-center py-12">
            <p className="text-lg font-semibold mb-2">No apps yet</p>
            <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
              Describe what you want to build and the AI agent will create it for you.
            </p>
            <button
              onClick={() => { if (projects[0]) onSelect(projects[0].id); else onNewChat(); }}
              className="px-6 py-3 rounded-xl font-semibold text-white"
              style={{ background: "var(--accent)", border: "none", cursor: "pointer" }}
            >
              Build your first app
            </button>
          </div>
        )}

        {/* Drafts first — work-in-progress is what you usually came back for */}
        {drafts.length > 0 && (
          <div className="mb-6">
            <h2 className="text-xs font-bold uppercase mb-3 tracking-wide" style={{ color: "var(--muted)" }}>Drafts ({drafts.length})</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {drafts.map((p) => (
                <AppCard key={p.id} project={p} status={statuses.get(p.id)} isCurrent={p.id === currentId} onSelect={onSelect} />
              ))}
            </div>
          </div>
        )}

        {deployed.length > 0 && (
          <div>
            <h2 className="text-xs font-bold uppercase mb-3 tracking-wide" style={{ color: "var(--muted)" }}>Live ({deployed.length})</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {deployed.map((p) => (
                <AppCard key={p.id} project={p} status={statuses.get(p.id)} isCurrent={p.id === currentId} onSelect={onSelect} />
              ))}
            </div>
          </div>
        )}

        {filtered.length === 0 && search && (
          <p className="text-center py-8 text-sm" style={{ color: "var(--muted)" }}>No apps matching "{search}"</p>
        )}
      </div>
    </div>
  );
}

function AppCard({ project, status, isCurrent, onSelect }: {
  project: Project;
  status?: DevStatus;
  isCurrent: boolean;
  onSelect: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);

  // Dot + label combine dev status (working/error) with resting state (live/draft).
  const working = status?.state === "working" || status?.state === "deploying";
  const errored = status?.state === "error";
  const dotColor = working ? "var(--warning)" : errored ? "var(--error)" : project.deployed ? "var(--success)" : "var(--line-strong)";
  const label = working || errored
    ? status!.detail
    : project.appId
    ? `${project.appId}.freeappstore.online`
    : "Draft";
  const labelColor = working ? "var(--warning)" : errored ? "var(--error)" : "var(--muted)";

  return (
    <button
      onClick={() => onSelect(project.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="w-full text-left p-4 border"
      style={{
        background: isCurrent ? "var(--accent-soft)" : "var(--panel)",
        borderColor: isCurrent ? "var(--accent)" : hover ? "var(--line-strong)" : "var(--line)",
        borderRadius: "var(--radius)",
        boxShadow: hover ? "var(--shadow-lg)" : "var(--shadow)",
        transform: hover ? "translateY(-1px)" : "none",
        transition: "box-shadow 0.15s ease, border-color 0.15s ease, transform 0.15s ease",
        cursor: "pointer",
      }}
    >
      <div className="flex items-center gap-2 mb-1" style={{ minWidth: 0 }}>
        <span
          className={working ? "status-pulse" : undefined}
          style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, color: dotColor, flexShrink: 0 }}
        />
        <span className="text-sm font-semibold truncate" style={{ color: "var(--ink-strong)", minWidth: 0 }}>{project.name}</span>
        {project.deployed && !working && !errored && (
          <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0" style={{ background: "color-mix(in srgb, var(--success) 14%, transparent)", color: "var(--success)" }}>Live</span>
        )}
      </div>
      <p className="text-xs truncate" style={{ color: labelColor, paddingLeft: 16, fontVariantNumeric: "tabular-nums" }}>
        {label}
      </p>
    </button>
  );
}
