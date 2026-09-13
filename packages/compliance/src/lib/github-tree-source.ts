/**
 * A FileSource backed by the GitHub Trees API (recursive), for auditing a
 * published repo from a Worker with no filesystem and no git.
 *
 * Uses no auth token — the weekly audit makes a handful of calls, well inside
 * GitHub's 60 req/hr unauthenticated limit. Any failure (404, 403/429 rate
 * limit, network error, timeout, truncated tree) yields `null` from
 * listTracked(), so checkNoCommittedArtifacts degrades to `warn` instead of
 * reporting a result it could not actually observe.
 *
 * Only listTracked() is meaningful: file contents are never fetched.
 */
import type { FileSource } from './file-source.js';

interface GithubTreeItem {
  path: string;
  type: 'blob' | 'tree' | 'commit';
}

interface GithubTreeResponse {
  tree: GithubTreeItem[];
  truncated: boolean;
}

/** Same budget as the live-URL checks, so one slow API call can't stall a batch. */
const FETCH_TIMEOUT_MS = 8000;

export function githubTreeSource(org: string, repo: string, ref = 'HEAD'): FileSource {
  let treeCache: Promise<string[] | null> | undefined;

  async function fetchTree(): Promise<string[] | null> {
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'freeappstore-compliance-audit/1.0',
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // 404 = repo or ref gone, 403/429 = rate-limited. Neither says anything
      // about the repo's contents, so report "no view" rather than a verdict.
      if (!res.ok) return null;
      const data = (await res.json()) as GithubTreeResponse;
      // A truncated tree is missing entries — possibly exactly the ones this
      // check looks for — so a "pass" from it would be a false negative.
      if (data.truncated || !Array.isArray(data.tree)) return null;
      // Blobs only: `git ls-files` lists files, and counting the tree
      // entries for `web/dist` and `web/dist/assets` would inflate the tally.
      return data.tree.filter((item) => item.type === 'blob').map((item) => item.path);
    } catch {
      return null;
    }
  }

  return {
    async *list(): AsyncIterable<string> {
      // Not a content source: yields nothing, so any file-walking check run
      // against it sees an empty repo rather than unreadable paths.
    },

    async read(): Promise<string | null> {
      return null;
    },

    listTracked(): Promise<string[] | null> {
      treeCache ??= fetchTree();
      return treeCache;
    },
  };
}
