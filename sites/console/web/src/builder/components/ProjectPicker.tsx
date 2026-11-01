import { useState, useEffect, useRef } from "react";
import type { Project } from "../hooks/useProjects";

interface ProjectPickerProps {
  projects: Project[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, appId?: string) => void;
  onClose: () => void;
}

interface OrgRepo {
  id: string;
  name: string;
  description: string;
  url: string;
  updatedAt: string;
}

// Platform/infra repos to exclude
const EXCLUDED = new Set([
  "freeappstore", "freegamestore", "admin", "sdk", "platform", "template-standalone",
  "template-game-canvas", "template-game-cards",
  "template-game-grid", "template-game-3d", "submissions", "create",
  "ai", "vault", "ops", "brand",
]);

export function ProjectPicker({ projects, currentId, onSelect, onCreate, onClose }: ProjectPickerProps) {
  const [orgRepos, setOrgRepos] = useState<OrgRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "new">("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus the search field only when the user opens it — never on mount, so
  // the mobile keyboard doesn't pop up just from opening the picker.
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  useEffect(() => {
    // Fetch ALL repos from the org via GitHub API (works for any creation method)
    fetch("https://api.github.com/orgs/freeappstore-online/repos?per_page=100&sort=updated&direction=desc", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => r.json())
      .then((repos) => {
        if (!Array.isArray(repos)) return;
        const apps = repos
          .filter((r: any) => !EXCLUDED.has(r.name) && !r.name.startsWith("template-"))
          .map((r: any) => ({
            id: r.name,
            name: r.name,
            description: r.description || "",
            url: `https://${r.name}.freeappstore.online`,
            updatedAt: r.pushed_at || "",
          }));
        setOrgRepos(apps);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Merge + filter by search
  const q = search.toLowerCase();
  const localIds = new Set(projects.map((p) => p.appId).filter(Boolean));
  const filteredLocal = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.appId?.toLowerCase().includes(q));
  const orgOnly = orgRepos.filter((r) => !localIds.has(r.id) && !EXCLUDED.has(r.id) && (!q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)));

  function handleSelectOrg(repo: OrgRepo) {
    // Create a new VibeCode session for this org repo
    const existingProject = projects.find((p) => p.appId === repo.id);
    if (existingProject) {
      onSelect(existingProject.id);
    } else {
      // Create a VibeCode session linked to this repo
      onCreate(repo.name, repo.id);
      // The newly created project will be selected automatically
    }
    onClose();
  }

  function handleSelectLocal(project: Project) {
    onSelect(project.id);
    onClose();
  }

  function handleCreateNew() {
    if (!newName.trim()) return;
    onCreate(newName.trim());
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="rounded-2xl shadow-xl w-full max-w-md mx-4 bg-paper border border-line max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between gap-2 p-4 shrink-0 border-b border-line">
          <h2 className="font-display text-lg font-extrabold text-ink-strong">Projects</h2>
          <div className="flex items-center gap-1">
            {tab === "all" && (
              <button
                onClick={() => setSearchOpen((o) => { if (o) setSearch(""); return !o; })}
                title="Search apps"
                aria-label="Search apps"
                aria-pressed={searchOpen}
                className={`w-9 h-9 inline-flex items-center justify-center border rounded-control-sm cursor-pointer text-[0.95rem] ${searchOpen ? "bg-(--accent-soft) border-accent text-accent" : "bg-transparent border-line text-ink"}`}
              >
                <span aria-hidden>🔍</span>
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="w-9 h-9 inline-flex items-center justify-center bg-transparent border border-line rounded-control-sm text-muted text-[1.1rem] cursor-pointer">✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-line">
          <button onClick={() => setTab("all")} className={`flex-1 py-2 text-sm font-semibold bg-transparent border-0 border-b-2 cursor-pointer ${tab === "all" ? "text-ink border-b-accent" : "text-muted border-b-transparent"}`}>
            All Apps
          </button>
          <button onClick={() => setTab("new")} className={`flex-1 py-2 text-sm font-semibold bg-transparent border-0 border-b-2 cursor-pointer ${tab === "new" ? "text-ink border-b-accent" : "text-muted border-b-transparent"}`}>
            New
          </button>
        </div>

        {/* Search — hidden until the user taps the search button (no auto-keyboard) */}
        {tab === "all" && searchOpen && (
          <div className="px-3 pt-3 shrink-0">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search apps..."
              className="w-full p-2 rounded-lg border text-sm bg-paper border-line text-ink"
              onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearchOpen(false); } }}
            />
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3 min-h-0">
          {tab === "all" ? (
            <>
              {/* Local projects (have VibeCode sessions) */}
              {filteredLocal.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-semibold uppercase mb-1 px-1 text-muted tracking-[0.05em]">VibeCode projects</div>
                  {filteredLocal.map((p) => (
                    <button key={p.id} onClick={() => handleSelectLocal(p)} className={`w-full flex items-center gap-3 p-2.5 rounded-lg text-left mb-1 border-0 cursor-pointer text-ink ${p.id === currentId ? "bg-[color-mix(in_srgb,var(--accent)_10%,var(--paper))]" : "bg-transparent"}`}>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${p.deployed ? "bg-success" : "bg-(--line-strong)"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{p.name}</div>
                        {p.appId && <div className="text-xs truncate text-muted">{p.appId}</div>}
                      </div>
                      {p.id === currentId && <span className="text-xs text-accent">current</span>}
                    </button>
                  ))}
                </div>
              )}

              {/* Org repos (not in local) */}
              {loading ? (
                <div className="text-center py-4 text-sm text-muted">Loading apps from store...</div>
              ) : orgOnly.length > 0 ? (
                <div>
                  <div className="text-xs font-semibold uppercase mb-1 px-1 text-muted tracking-[0.05em]">GitHub repos</div>
                  {orgOnly.map((r) => (
                    <button key={r.id} onClick={() => handleSelectOrg(r)} className="w-full flex items-center gap-3 p-2.5 rounded-lg text-left mb-1 bg-transparent border-0 cursor-pointer text-ink">
                      <span className="w-2 h-2 rounded-full bg-accent shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{r.name}</div>
                        <div className="text-xs truncate text-muted">{r.description || r.id}</div>
                      </div>
                      <span className="text-xs text-muted">open</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            /* New project */
            <div className="py-4">
              <p className="text-sm mb-3 text-muted">Start a new app from scratch.</p>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="App name..."
                autoFocus
                className="w-full p-2.5 rounded-lg border mb-3 text-sm bg-paper border-line text-ink"
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateNew(); }}
              />
              <button onClick={handleCreateNew} disabled={!newName.trim()} className="w-full p-2.5 rounded-lg font-semibold text-sm text-white bg-accent border-0 cursor-pointer disabled:opacity-50">
                Create Project
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
