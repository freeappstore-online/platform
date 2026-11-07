// GitHub Git Data API helpers for the write tools: fetch a template's files,
// push a set of files as one commit, and read files back. All via plain fetch
// (no deps). Text files are base64-(de)coded UTF-8 safe; binary passes through.

const UA = "freeappstore-mcp";

async function gh(token: string | undefined, url: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) json.__status = res.status;
  return json;
}

// UTF-8-safe base64 (atob/btoa are latin1-only).
function b64ToText(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Repo names and file paths come from tool input and are interpolated into
// API URLs sent with the server's org token. URL parsing collapses `..`
// segments, so an unchecked `../other-org/repo` reads any repo that token can
// reach. Allow only a plain repo name and plain path segments.
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A plain repo name — safe in an API path, and as the label of `<name>.freeappstore.online`. */
export function isRepoName(name: string): boolean {
  return REPO_RE.test(name) && !name.includes("..");
}

function repoBase(org: string, repo: string): string {
  if (!isRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  return `https://api.github.com/repos/${org}/${repo}`;
}

function encodePath(path: string): string {
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new Error(`invalid file path: ${path}`);
  return segments.map(encodeURIComponent).join("/");
}

export interface RepoFile {
  content: string; // base64
  encoding: "base64";
}

/**
 * Push a set of files to org/repo's main branch. An existing repo gets one
 * commit that preserves untouched files via base_tree. The Git Data API cannot
 * write to an EMPTY repo, so its first commit is made through the Contents API
 * with one real file from the set (never a placeholder), then the rest follows.
 * A workflow file is never that first file: GitHub runs the workflows a push
 * contains, and a push of only a few files would run (and fail) the deploy
 * before the rest arrived. Returns the last commit sha.
 */
export async function pushFiles(
  org: string,
  repo: string,
  token: string,
  allFiles: Map<string, RepoFile>,
  message: string,
): Promise<string> {
  let files = allFiles;
  const base = repoBase(org, repo);

  let parentSha: string | undefined;
  let baseTree: string | undefined;
  const ref = await gh(token, `${base}/git/ref/heads/main`);
  if (ref?.object?.sha) {
    parentSha = ref.object.sha;
    const parent = await gh(token, `${base}/git/commits/${parentSha}`);
    baseTree = parent?.tree?.sha;
  } else {
    // 404 (no main) and 409 ("Git Repository is empty") mean an empty repo; anything else is an outage.
    if (ref?.__status !== 404 && ref?.__status !== 409) throw new Error(`cannot read ${repo} main: ${ref?.message ?? ref?.__status}`);
    // Empty repo: the first commit holds one real, non-workflow file.
    const first = [...files.keys()].find((path) => !path.startsWith(".github/"));
    if (!first) throw new Error("cannot seed an empty repo: no non-workflow file to commit first");
    const seed = await gh(token, `${base}/contents/${encodePath(first)}`, "PUT", {
      message,
      content: files.get(first)!.content,
    });
    if (!seed?.commit?.sha) throw new Error(`first commit failed: ${seed.message ?? seed.__status}`);
    const seedSha: string = seed.commit.sha;
    parentSha = seedSha;
    const parent = await gh(token, `${base}/git/commits/${seedSha}`);
    baseTree = parent?.tree?.sha;
    files = new Map([...files].filter(([path]) => path !== first));
    if (files.size === 0) return seedSha;
  }

  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const [path, f] of files) {
    const blob = await gh(token, `${base}/git/blobs`, "POST", { content: f.content, encoding: f.encoding });
    if (!blob?.sha) throw new Error(`blob create failed for ${path}: ${blob.message ?? blob.__status}`);
    treeItems.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await gh(token, `${base}/git/trees`, "POST", { base_tree: baseTree, tree: treeItems });
  if (!tree?.sha) throw new Error(`tree create failed: ${tree.message ?? tree.__status}`);

  const commit = await gh(token, `${base}/git/commits`, "POST", {
    message,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  });
  if (!commit?.sha) throw new Error(`commit create failed: ${commit.message ?? commit.__status}`);

  const upd = await gh(token, `${base}/git/refs/heads/main`, "PATCH", { sha: commit.sha });
  if (!upd?.ref) throw new Error(`ref update failed: ${upd.message ?? upd.__status}`);
  return commit.sha;
}

/**
 * List file paths in a repo (recursive). Read-only; works on public repos.
 * Only a repo with no main branch (404, or 409 "empty") lists as []; any other
 * failure throws. create_app scaffolds whatever the listing says is missing, so
 * a GitHub blip read as "empty" would push the starter over an existing app.
 */
export async function listRepoFiles(org: string, repo: string, token?: string): Promise<string[]> {
  const base = repoBase(org, repo);
  const ref = await gh(token, `${base}/git/ref/heads/main`);
  const headSha = ref?.object?.sha;
  if (!headSha) {
    if (ref?.__status === 404 || ref?.__status === 409) return [];
    throw new Error(`cannot read ${repo} main: ${ref?.message ?? ref?.__status}`);
  }
  const tree = await gh(token, `${base}/git/trees/${headSha}?recursive=1`);
  if (!Array.isArray(tree?.tree)) throw new Error(`cannot list ${repo} files: ${tree?.message ?? tree?.__status}`);
  if (tree.truncated) throw new Error(`${repo} has too many files to list in one call`);
  return tree.tree.filter((i: any) => i.type === "blob" && !i.path.startsWith(".git/")).map((i: any) => i.path);
}

/** Read one file's raw bytes from a repo (icons and other binary files). */
export async function readRepoBytes(org: string, repo: string, token: string | undefined, path: string): Promise<Uint8Array | null> {
  const base = repoBase(org, repo);
  const res = await gh(token, `${base}/contents/${encodePath(path)}`);
  if (typeof res?.content !== "string") return null;
  return Uint8Array.from(atob(res.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
}

/** Read one file's text content from a repo. */
export async function readRepoFile(org: string, repo: string, token: string | undefined, path: string): Promise<string | null> {
  const base = repoBase(org, repo);
  const res = await gh(token, `${base}/contents/${encodePath(path)}`);
  if (typeof res?.content !== "string") return null;
  return b64ToText(res.content);
}

export { textToB64, b64ToText };
