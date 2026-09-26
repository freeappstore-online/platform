/** Read an existing app's repo into a VibeCode session (#12). */

/** A session tracks at most this many files (session.ts MAX_FILES matches). */
export const IMPORT_MAX_FILES = 200;
export const IMPORT_MAX_FILE_BYTES = 512 * 1024;
/** The session is stored as one Durable Object value (2 MB including key),
 *  holding the files, a baseline copy of them and the chat. Past ~750 KB of
 *  source the save itself would fail. */
export const IMPORT_MAX_TOTAL_BYTES = 750 * 1024;

const IMPORTABLE_EXTS = new Set(["ts", "tsx", "js", "jsx", "json", "html", "css", "md", "yaml", "yml", "toml", "txt", "svg", "sh"]);
const SKIP_PATHS = ["node_modules/", "dist/"];
const SKIP_FILES = new Set(["pnpm-lock.yaml", "package-lock.json"]);

type TreeEntry = { path: string; type: string; size?: number };

export type RepoImport = { ok: true; files: Record<string, string> } | { ok: false; status: number; error: string };

/** Source text only: no dotfiles (platform-owned workflows), vendor/build output, lockfiles or binaries. */
function isImportable(e: TreeEntry): boolean {
  if (e.type !== "blob") return false;
  if (e.path.startsWith(".") || SKIP_PATHS.some((p) => e.path.includes(p))) return false;
  if (SKIP_FILES.has(e.path)) return false;
  const ext = e.path.split(".").pop()?.toLowerCase() ?? "";
  return IMPORTABLE_EXTS.has(ext);
}

const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/**
 * The repo's importable files, or why it can't be imported. Limits are refused
 * outright rather than truncated: a session that silently lacks part of the
 * app would let the model edit it blind.
 */
export async function fetchRepoFiles(repo: string, agentName: string, token?: string): Promise<RepoImport> {
  const ghHeaders: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": agentName };
  if (token) ghHeaders.Authorization = `Bearer ${token}`;

  const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, { headers: ghHeaders });
  if (!treeRes.ok) return { ok: false, status: 404, error: `Could not read repo ${repo}` };
  const treeData = (await treeRes.json()) as { tree: TreeEntry[]; truncated?: boolean };
  if (treeData.truncated) return { ok: false, status: 400, error: `${repo} is too large to import (GitHub truncated its file list).` };

  const candidates = treeData.tree.filter(isImportable);
  if (candidates.length === 0) return { ok: false, status: 404, error: `${repo} has no source files to import.` };

  const oversized = candidates.find((f) => (f.size ?? 0) > IMPORT_MAX_FILE_BYTES);
  if (oversized) {
    return {
      ok: false,
      status: 400,
      error: `${oversized.path} is ${kb(oversized.size ?? 0)}; files over ${kb(IMPORT_MAX_FILE_BYTES)} can't be imported.`,
    };
  }
  if (candidates.length > IMPORT_MAX_FILES) {
    return { ok: false, status: 400, error: `${repo} has ${candidates.length} source files; at most ${IMPORT_MAX_FILES} can be imported.` };
  }
  const total = candidates.reduce((sum, f) => sum + (f.size ?? 0), 0);
  if (total > IMPORT_MAX_TOTAL_BYTES) {
    return { ok: false, status: 400, error: `${repo} has ${kb(total)} of source; at most ${kb(IMPORT_MAX_TOTAL_BYTES)} can be imported.` };
  }

  const files: Record<string, string> = {};
  const rawHeaders = { ...ghHeaders, Accept: "application/vnd.github.raw+json" };
  for (let i = 0; i < candidates.length; i += 10) {
    const batch = candidates.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (f) => {
        const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}?ref=main`, { headers: rawHeaders });
        return fileRes.ok ? { path: f.path, content: await fileRes.text() } : { path: f.path, content: null };
      }),
    );
    for (const r of results) {
      if (r.content === null) return { ok: false, status: 502, error: `Could not read ${r.path} from ${repo}; try again.` };
      files[r.path] = r.content;
    }
  }
  return { ok: true, files };
}
