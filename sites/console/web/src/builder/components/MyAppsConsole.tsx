import { useEffect, useState } from "react";
import type { Project, ProjectsLoadError } from "../hooks/useProjects";
import { useAuth } from "../hooks/useAuth";
import { useAppStatuses, type DevStatus } from "../hooks/useAppStatuses";

export function MyAppsConsole({ projects, loading, error, onRetry, currentId, onSelect, onNewChat }: {
  projects: Project[];
  loading: boolean;
  error: ProjectsLoadError;
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
    <div className="flex-1 overflow-y-auto overflow-x-hidden">
      <div className="container py-6 max-w-[720px]">
        {/* "Projects", not "My Apps": the console's Apps page is the list of apps (#588). */}
        <div className="flex items-center justify-between gap-2 mb-5">
          <h1 className="text-lg font-bold text-ink">Projects</h1>
          <button
            onClick={onNewChat}
            title="New app"
            aria-label="New app"
            className="rounded-lg font-semibold text-white inline-flex items-center justify-center gap-1.5 shrink-0 bg-accent border-0 cursor-pointer min-h-[40px] p-[0_0.85rem] text-[0.9rem]"
          >
            <span aria-hidden className="text-[1.1rem] leading-[1]">+</span>
            <span className="hidden sm:inline">New App</span>
          </button>
        </div>

        {/* Search + sort */}
        <div className="mb-5 flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps..."
            className="flex-1 p-3 rounded-xl border text-sm bg-panel border-line text-ink"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as "edited" | "name")}
            aria-label="Sort apps"
            className="rounded-xl border text-sm px-3 bg-panel border-line text-ink"
          >
            <option value="edited">Last edited</option>
            <option value="name">Name</option>
          </select>
        </div>

        {loading && (
          <div className="text-center py-12">
            <div className="inline-block w-6 h-6 border-2 rounded-full animate-spin mb-3 border-line border-t-accent"  />
            <p className="text-sm text-muted">Loading your apps…</p>
          </div>
        )}

        {/* Load failure — distinguish expired session from connection issues */}
        {!loading && error && projects.length === 0 && (
          <div className="text-center py-12">
            {error === 'auth' ? (
              <AuthExpiredBanner />
            ) : (
              <>
                <p className="text-sm font-semibold mb-1">Couldn't load your apps</p>
                <p className="text-xs mb-4 text-muted">
                  Your apps are safe on the server — this was a connection issue.
                </p>
                <button onClick={onRetry} className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-accent border-0 cursor-pointer">
                  Retry
                </button>
              </>
            )}
          </div>
        )}

        {!loading && !error && projects.length <= 1 && !projects[0]?.deployed && (
          <div className="text-center py-12">
            <p className="text-lg font-semibold mb-2">No apps yet</p>
            <p className="text-sm mb-6 text-muted">
              Describe what you want to build and the AI agent will create it for you.
            </p>
            <button
              onClick={() => { if (projects[0]) onSelect(projects[0].id); else onNewChat(); }}
              className="px-6 py-3 rounded-xl font-semibold text-white bg-accent border-0 cursor-pointer"
            >
              Build your first app
            </button>
          </div>
        )}

        {/* Drafts first — work-in-progress is what you usually came back for */}
        {drafts.length > 0 && (
          <div className="mb-6">
            <h2 className="text-xs font-bold uppercase mb-3 tracking-wide text-muted">Drafts ({drafts.length})</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {drafts.map((p) => (
                <AppCard key={p.id} project={p} status={statuses.get(p.id)} isCurrent={p.id === currentId} onSelect={onSelect} />
              ))}
            </div>
          </div>
        )}

        {deployed.length > 0 && (
          <div>
            <h2 className="text-xs font-bold uppercase mb-3 tracking-wide text-muted">Live ({deployed.length})</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {deployed.map((p) => (
                <AppCard key={p.id} project={p} status={statuses.get(p.id)} isCurrent={p.id === currentId} onSelect={onSelect} />
              ))}
            </div>
          </div>
        )}

        {filtered.length === 0 && search && (
          <p className="text-center py-8 text-sm text-muted">No apps matching "{search}"</p>
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

  // Dot + label combine dev status (working/error) with resting state (live/draft).
  const working = status?.state === "working" || status?.state === "deploying";
  const errored = status?.state === "error";
  const dotClass = working ? "bg-warning text-warning" : errored ? "bg-danger text-danger" : project.deployed ? "bg-success text-success" : "bg-(--line-strong) text-(--line-strong)";
  const label = working || errored
    ? status!.detail
    : project.appId
    ? `${project.appId}.freeappstore.online`
    : "Draft";
  const labelClass = working ? "text-warning" : errored ? "text-danger" : "text-muted";

  return (
    <button
      onClick={() => onSelect(project.id)}
      className={`w-full text-left p-4 border rounded-control shadow-control hover:shadow-(--shadow-lg) hover:-translate-y-px transition-[box-shadow,border-color,transform] duration-150 ease-[ease] cursor-pointer ${isCurrent ? "bg-(--accent-soft) border-accent" : "bg-panel border-line hover:border-(--line-strong)"}`}
    >
      <div className="flex items-center gap-2 mb-1 min-w-0">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${dotClass} ${working ? "status-pulse" : ""}`}
        />
        <span className="text-sm font-semibold truncate text-ink-strong min-w-0">{project.name}</span>
        {project.deployed && !working && !errored && (
          <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0 bg-[color-mix(in_srgb,_var(--success)_14%,_transparent)] text-success">Live</span>
        )}
      </div>
      <p className={`text-xs truncate pl-4 tabular-nums ${labelClass}`}>
        {label}
      </p>
    </button>
  );
}

/** Shown when the sessions fetch returns 401 (session expired). */
function AuthExpiredBanner() {
  const { signIn } = useAuth();
  return (
    <>
      <p className="text-sm font-semibold mb-1">Session expired</p>
      <p className="text-xs mb-4 text-muted">
        Please sign in again to load your apps.
      </p>
      <button
        onClick={signIn}
        className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-accent border-0 cursor-pointer"
      >
        Sign in again
      </button>
    </>
  );
}
