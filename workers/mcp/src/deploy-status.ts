// deploy_status: the latest GitHub Actions runs of an app repo (#453).
//
// Authenticated with the worker's server-side GitHub token so the shared
// egress IP does not hit the anonymous 60/hour limit, but still read-only and
// limited to PUBLIC repos of the app org: a private repo is reported as not
// found, exactly what an anonymous call would have seen. Failures keep
// GitHub's message and rate-limit headers so a creator can tell a rate limit
// from a permission or upstream failure.

const UA = "freeappstore-mcp";
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface DeployRun {
  name: string;
  status: string;
  updatedAt: string;
  url: string;
  sha: string;
}

export type DeployStatusResult = { runs: DeployRun[] } | { error: string };

async function ghGet(url: string, token: string | undefined): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** A short, safe explanation of a failed GitHub response. */
async function describeFailure(res: Response, actionsUrl: string): Promise<string> {
  let message = "";
  try {
    message = String(((await res.json()) as { message?: unknown }).message ?? "").slice(0, 200);
  } catch {
    // no JSON body
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(res.headers.get("retry-after"));
  const requestId = res.headers.get("x-github-request-id");
  const trace = requestId ? ` (GitHub request ${requestId})` : "";
  const fallback = ` Runs are public at ${actionsUrl}.`;

  const limited = res.status === 429 || (res.status === 403 && (remaining === "0" || /rate limit/i.test(message) || retryAfter > 0));
  if (limited) {
    const wait = retryAfter > 0 ? retryAfter : reset > 0 ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : 0;
    return `GitHub rate limit reached${wait ? `; retry in about ${wait}s` : ""}.${fallback}${trace}`;
  }
  if (res.status === 403) return `GitHub refused the request (permission denied${message ? `: ${message}` : ""}).${fallback}${trace}`;
  if (res.status === 404) return `No repository or workflow runs found for this app. Check the app_id.`;
  if (res.status >= 500) return `GitHub is failing upstream (HTTP ${res.status}). Try again shortly.${fallback}${trace}`;
  return `GitHub API ${res.status}${message ? `: ${message}` : ""}.${fallback}${trace}`;
}

export async function getDeployStatus(org: string, appId: string, token?: string): Promise<DeployStatusResult> {
  if (!REPO_RE.test(appId) || appId.includes("..")) return { error: `invalid app_id: ${appId}` };
  const actionsUrl = `https://github.com/${org}/${appId}/actions`;
  const repoUrl = `https://api.github.com/repos/${org}/${appId}`;
  try {
    // Only public repos: the token must never expose a private repo's runs.
    const repoRes = await ghGet(repoUrl, token);
    if (!repoRes.ok) return { error: await describeFailure(repoRes, actionsUrl) };
    if (((await repoRes.json()) as { private?: boolean }).private !== false) {
      return { error: "No repository or workflow runs found for this app. Check the app_id." };
    }
    const res = await ghGet(`${repoUrl}/actions/runs?per_page=5`, token);
    if (!res.ok) return { error: await describeFailure(res, actionsUrl) };
    const data = (await res.json()) as {
      workflow_runs?: Array<{ name: string; conclusion: string | null; status: string; updated_at: string; html_url: string; head_sha: string }>;
    };
    return {
      runs: (data.workflow_runs ?? []).map((r) => ({
        name: r.name,
        status: r.conclusion ?? r.status,
        updatedAt: r.updated_at,
        url: r.html_url,
        sha: r.head_sha?.slice(0, 7),
      })),
    };
  } catch (e) {
    return { error: `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}.` };
  }
}
