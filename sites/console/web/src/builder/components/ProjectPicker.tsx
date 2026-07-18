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
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
      <div className="rounded-2xl shadow-xl w-full max-w-md mx-4" style={{ background: "var(--panel)", border: "1px solid var(--line)", maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between gap-2 p-4 shrink-0" style={{ borderBottom: "1px solid var(--line)" }}>
          <h2 className="font-display text-lg font-extrabold" style={{ color: "var(--ink-strong)" }}>Projects</h2>
          <div className="flex items-center gap-1">
            {tab === "all" && (
              <button
                onClick={() => setSearchOpen((o) => { if (o) setSearch(""); return !o; })}
                title="Search apps"
                aria-label="Search apps"
                aria-pressed={searchOpen}
                style={{ width: 36, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center", background: searchOpen ? "var(--accent-soft)" : "none", border: `1px solid ${searchOpen ? "var(--accent)" : "var(--line)"}`, borderRadius: "var(--radius-sm)", color: searchOpen ? "var(--accent)" : "var(--ink)", cursor: "pointer", fontSize: "0.95rem" }}
              >
                <span aria-hidden>🔍</span>
              </button>
            )}
            <button onClick={onClose} aria-label="Close" style={{ width: 36, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", color: "var(--muted)", fontSize: "1.1rem", cursor: "pointer" }}>✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0" style={{ borderBottom: "1px solid var(--line)" }}>
          <button onClick={() => setTab("all")} className="flex-1 py-2 text-sm font-semibold" style={{ background: "none", border: "none", cursor: "pointer", color: tab === "all" ? "var(--ink)" : "var(--muted)", borderBottom: tab === "all" ? "2px solid var(--accent)" : "2px solid transparent" }}>
            All Apps
          </button>
          <button onClick={() => setTab("new")} className="flex-1 py-2 text-sm font-semibold" style={{ background: "none", border: "none", cursor: "pointer", color: tab === "new" ? "var(--ink)" : "var(--muted)", borderBottom: tab === "new" ? "2px solid var(--accent)" : "2px solid transparent" }}>
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
              className="w-full p-2 rounded-lg border text-sm"
              style={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)" }}
              onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearchOpen(false); } }}
            />
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3" style={{ minHeight: 0 }}>
          {tab === "all" ? (
            <>
              {/* Local projects (have VibeCode sessions) */}
              {filteredLocal.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-semibold uppercase mb-1 px-1" style={{ color: "var(--muted)", letterSpacing: "0.05em" }}>VibeCode projects</div>
                  {filteredLocal.map((p) => (
                    <button key={p.id} onClick={() => handleSelectLocal(p)} className="w-full flex items-center gap-3 p-2.5 rounded-lg text-left mb-1" style={{ background: p.id === currentId ? "color-mix(in srgb, var(--accent) 10%, var(--panel))" : "transparent", border: "none", cursor: "pointer", color: "var(--ink)" }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.deployed ? "#16a34a" : "var(--line-strong)", flexShrink: 0 }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{p.name}</div>
                        {p.appId && <div className="text-xs truncate" style={{ color: "var(--muted)" }}>{p.appId}</div>}
                      </div>
                      {p.id === currentId && <span className="text-xs" style={{ color: "var(--accent)" }}>current</span>}
                    </button>
                  ))}
                </div>
              )}

              {/* Org repos (not in local) */}
              {loading ? (
                <div className="text-center py-4 text-sm" style={{ color: "var(--muted)" }}>Loading apps from store...</div>
              ) : orgOnly.length > 0 ? (
                <div>
                  <div className="text-xs font-semibold uppercase mb-1 px-1" style={{ color: "var(--muted)", letterSpacing: "0.05em" }}>GitHub repos</div>
                  {orgOnly.map((r) => (
                    <button key={r.id} onClick={() => handleSelectOrg(r)} className="w-full flex items-center gap-3 p-2.5 rounded-lg text-left mb-1" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--ink)" }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{r.name}</div>
                        <div className="text-xs truncate" style={{ color: "var(--muted)" }}>{r.description || r.id}</div>
                      </div>
                      <span className="text-xs" style={{ color: "var(--muted)" }}>open</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            /* New project */
            <div className="py-4">
              <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Start a new app from scratch.</p>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="App name..."
                autoFocus
                className="w-full p-2.5 rounded-lg border mb-3 text-sm"
                style={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)" }}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateNew(); }}
              />
              <button onClick={handleCreateNew} disabled={!newName.trim()} className="w-full p-2.5 rounded-lg font-semibold text-sm text-white" style={{ background: "var(--accent)", border: "none", cursor: "pointer", opacity: newName.trim() ? 1 : 0.5 }}>
                Create Project
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
