/** Deploy: provision via GitHub APIs, then push agent-authored deltas. */

import type { StoreConfig } from "./config";
import { makeGhApi } from "./github";

export interface DeployConfig {
  id: string;
  name: string;
  category: string;
  icon: string;
  iconBg: string;
  description: string;
}

export interface DeployEnv {
  GITHUB_TOKEN: string;
  PLATFORM?: Fetcher;
  DB?: D1Database;
}

interface DeployStep {
  name: string;
  status: "ok" | "skip" | "fail";
  detail: string;
}

export type DeployStatus =
  | { phase: "provisioning"; steps: DeployStep[] }
  | { phase: "pushing"; progress: string }
  | { phase: "building"; deployUrl: string }
  | { phase: "live"; appUrl: string }
  | { phase: "error"; error: string };

/** How a deploy run ended. */
export type TerminalDeployStatus = Extract<DeployStatus, { phase: "live" | "error" }>;

type TreeItem = { path: string; mode: string; type: string; sha: string | null };
type GhResponse = { _httpStatus?: number; message?: string; [key: string]: any };
export type FileDelta = Map<string, string | null>;
export type PushUpdateResult =
  | { ok: true; message: string; commitSha: string; skipped?: false }
  | { ok: true; message: string; skipped: true; commitSha?: undefined }
  | { ok: false; message: string };
type WorkflowRun = { id: number; status?: string; conclusion?: string | null; head_sha?: string };
const INITIAL_COMMIT_PREFIX = "Initialize FreeAppStore scaffold: ";

function apiStatus(response: GhResponse, fallback: number): number {
  return response._httpStatus ?? fallback;
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function gitBlobSha(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", object);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentsPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function createTreeItems(ghApi: ReturnType<typeof makeGhApi>, repo: string, files: FileDelta): Promise<TreeItem[]> {
  const items: TreeItem[] = [];
  for (const [path, content] of files) {
    if (content === null) {
      items.push({ path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await ghApi(`/repos/${repo}/git/blobs`, "POST", { content, encoding: "utf-8" });
    if (!blob.sha) throw new Error(`Failed to create blob for ${path}: ${blob.message || "unknown error"}`);
    items.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  return items;
}

export function computeFileDelta(files: Map<string, string>, baselineFiles: Map<string, string>): FileDelta {
  const delta: FileDelta = new Map();
  for (const [path, content] of files) {
    if (baselineFiles.get(path) !== content) delta.set(path, content);
  }
  for (const path of baselineFiles.keys()) {
    if (!files.has(path)) delta.set(path, null);
  }
  return delta;
}

function toFileDelta(files: Map<string, string>): FileDelta {
  return new Map([...files.entries()]);
}

function deltaDetail(delta: FileDelta): string {
  const paths = [...delta.keys()].sort();
  const sample = paths.slice(0, 5).join(", ");
  const suffix = paths.length > 5 ? `, +${paths.length - 5} more` : "";
  return `${paths.length} agent-authored file${paths.length === 1 ? "" : "s"}${sample ? ` (${sample}${suffix})` : ""}`;
}

/** Deploy = create repo + push code. No DNS, no registry.
 *  Those are for PUBLISH (separate action). */
export async function deployApp(
  deployConfig: DeployConfig,
  files: Map<string, string>,
  env: DeployEnv,
  config: StoreConfig,
  onStatus: (status: DeployStatus) => void | Promise<void>,
  /** Only true when the caller has proven this id is already theirs (redeploy /
   *  retry). A pre-existing repo under any other circumstance is a collision —
   *  pushing into it would overwrite a stranger's code (#29). */
  allowExistingRepo = false,
  baselineFiles: Map<string, string> = new Map(),
): Promise<void> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const steps: DeployStep[] = [];
  await onStatus({ phase: "provisioning", steps: [] });

  // Step 1: Create GitHub repo
  const repoPath = `/repos/${config.org}/${deployConfig.id}`;
  const repoCheck = (await ghApi(repoPath)) as GhResponse;
  const repoStatus = apiStatus(repoCheck, repoCheck.id ? 200 : 404);
  if (repoStatus !== 200 && repoStatus !== 404) {
    const detail = repoCheck.message || `GitHub returned HTTP ${repoStatus}`;
    steps.push({ name: "GitHub repo", status: "fail", detail });
    await onStatus({ phase: "error", error: `GitHub repo check failed (${repoStatus}): ${detail}` });
    return;
  }
  if (repoStatus === 200 && !repoCheck.id) {
    await onStatus({ phase: "error", error: `GitHub repository response for ${config.org}/${deployConfig.id} did not include an ID.` });
    return;
  }
  if (repoStatus === 200 && repoCheck.default_branch && repoCheck.default_branch !== "main") {
    await onStatus({
      phase: "error",
      error: `Refusing to deploy into ${config.org}/${deployConfig.id}: its default branch is ${repoCheck.default_branch}, not main.`,
    });
    return;
  }
  if (repoStatus === 200 && repoCheck.id) {
    if (!allowExistingRepo) {
      // Someone else's repo (or drift). Pushing here would land this session's
      // code on top of theirs and, once GH Actions runs, replace their live app
      // in R2 under the same prefix. Stop before the first byte is written.
      const detail = `${config.org}/${deployConfig.id} already exists and is not this session's ${config.noun}`;
      steps.push({ name: "GitHub repo", status: "fail", detail });
      await onStatus({
        phase: "error",
        error: `Refusing to deploy into an existing ${config.noun} repo: ${detail}. Deploy under a different ID.`,
      });
      return;
    }
    steps.push({ name: "GitHub repo", status: "skip", detail: `${config.org}/${deployConfig.id} already exists` });
  } else if (repoStatus === 404) {
    const createRepo = (await ghApi(`/orgs/${config.org}/repos`, "POST", {
      name: deployConfig.id,
      private: false,
      description: (deployConfig.description || "").slice(0, 200),
      auto_init: false,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    })) as GhResponse;
    if (createRepo.id) {
      steps.push({ name: "GitHub repo", status: "ok", detail: `Created ${config.org}/${deployConfig.id}` });
    } else if ((apiStatus(createRepo, 0) === 409 || apiStatus(createRepo, 0) === 422) && allowExistingRepo) {
      const racedRepo = (await ghApi(repoPath)) as GhResponse;
      if (apiStatus(racedRepo, racedRepo.id ? 200 : 404) !== 200 || !racedRepo.id) {
        const detail = racedRepo.message || createRepo.message || "Repository creation raced but the repository could not be verified";
        await onStatus({ phase: "error", error: `GitHub repo creation failed: ${detail}` });
        return;
      }
      steps.push({ name: "GitHub repo", status: "skip", detail: `${config.org}/${deployConfig.id} was created concurrently` });
    } else {
      const status = apiStatus(createRepo, 0);
      const detail = createRepo.message || `GitHub returned HTTP ${status || "unknown"}`;
      steps.push({ name: "GitHub repo", status: "fail", detail });
      await onStatus({ phase: "error", error: `GitHub repo creation failed (${status || "unknown status"}): ${detail}` });
      return;
    }
  }
  await onStatus({ phase: "provisioning", steps: [...steps] });

  // Step 2: ensure the platform scaffold exists, then push only the
  // agent-authored delta. This preserves workflow/lockfile/icon/analytics/SDK
  // files generated by provisioning while still deploying the app code.
  let repoHasMain = await hasMainBranch(deployConfig.id, env.GITHUB_TOKEN, config);
  let buildCommitSha: string | undefined;
  const repo = `${config.org}/${deployConfig.id}`;
  const initialPath = baselineFiles.has("pnpm-workspace.yaml") ? "pnpm-workspace.yaml" : baselineFiles.keys().next().value;
  const initialContent = initialPath ? baselineFiles.get(initialPath) : undefined;
  let needsScaffold = !repoHasMain && baselineFiles.size > 0;

  if (needsScaffold && initialPath && initialContent !== undefined) {
    needsScaffold = await initializeEmptyRepo(repo, deployConfig.id, initialPath, initialContent, baselineFiles, ghApi);
    repoHasMain = true;
  } else if (repoHasMain && allowExistingRepo && initialPath && initialContent !== undefined) {
    needsScaffold = await isBootstrapCommitOnly(repo, initialPath, initialContent, baselineFiles, ghApi);
  }

  if (needsScaffold && repoHasMain && baselineFiles.size > 0) {
    await onStatus({ phase: "pushing", progress: "Provisioning platform scaffold..." });
    buildCommitSha = await commitPatchToGitHub(
      deployConfig.id,
      toFileDelta(baselineFiles),
      `Provision ${config.noun} scaffold`,
      env.GITHUB_TOKEN,
      config,
    );
    steps.push({ name: "Platform scaffold", status: "ok", detail: "Seeded baseline template" });
    await onStatus({ phase: "provisioning", steps: [...steps] });
  }

  const delta = computeFileDelta(files, baselineFiles);
  if (delta.size === 0) {
    steps.push({
      name: "Pushing code",
      status: "skip",
      detail: "No agent-authored changes to push; platform scaffold deploy already triggered",
    });
  } else {
    await onStatus({ phase: "pushing", progress: `Pushing ${deltaDetail(delta)}...` });
    buildCommitSha = await commitPatchToGitHub(
      deployConfig.id,
      delta,
      `Deploy ${config.noun} delta — built with ${config.storeName} AI agent`,
      env.GITHUB_TOKEN,
      config,
    );
    steps.push({ name: "Pushing code", status: "ok", detail: `Pushed ${deltaDetail(delta)}` });
  }
  await onStatus({ phase: "provisioning", steps: [...steps] });

  // Step 3: Wait for GitHub Actions deploy
  if (buildCommitSha) {
    await waitForGitHubDeploy(deployConfig.id, env, config, onStatus, buildCommitSha);
  } else {
    await onStatus({ phase: "live", appUrl: `https://${deployConfig.id}.${config.domain}` });
  }
}

/** How long deploy/push_update wait for GitHub Actions before reporting "still building". */
export const DEPLOY_POLL_TIMEOUT_MS = 150_000;
const DEPLOY_POLL_INTERVAL_MS = 8000;

/**
 * One look at the app's deploy workflow run. Returns the terminal status
 * (`live`, or `error` with the failure reason), or null while the run is
 * missing or still in progress. With `commitSha` it only considers the run for
 * that commit, so an older run's result is never mistaken for this push's.
 */
export async function readDeployRun(
  appId: string,
  env: DeployEnv,
  config: StoreConfig,
  commitSha?: string,
): Promise<TerminalDeployStatus | null> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const repo = `${config.org}/${appId}`;
  const runs = await ghApi(`/repos/${repo}/actions/runs?per_page=10`);
  const workflowRuns = (runs.workflow_runs || []) as WorkflowRun[];
  const run = commitSha ? workflowRuns.find((r) => r.head_sha === commitSha) : workflowRuns[0];
  if (!run || run.status !== "completed") return null;
  if (run.conclusion === "success") return { phase: "live", appUrl: `https://${appId}.${config.domain}` };
  if (run.conclusion === "failure") return { phase: "error", error: await fetchCIFailureDetails(ghApi, repo, run.id, env.GITHUB_TOKEN) };
  return {
    phase: "error",
    error: `GitHub Actions deploy ended with ${run.conclusion ?? "no conclusion"}. Check: https://github.com/${repo}/actions/runs/${run.id}`,
  };
}

/**
 * Poll the deploy run until it finishes or DEPLOY_POLL_TIMEOUT_MS passes.
 * Reports every change through `onStatus` and returns the terminal status, or
 * null on timeout. A timeout leaves the status at `building`: CI may still
 * fail, so it must not be reported as live (#11).
 */
export async function waitForGitHubDeploy(
  appId: string,
  env: DeployEnv,
  config: StoreConfig,
  onStatus: (status: DeployStatus) => void | Promise<void>,
  commitSha?: string,
): Promise<TerminalDeployStatus | null> {
  await onStatus({ phase: "building", deployUrl: `https://${appId}.${config.domain}` });

  const deadline = Date.now() + DEPLOY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DEPLOY_POLL_INTERVAL_MS);
    let status: TerminalDeployStatus | null;
    try {
      status = await readDeployRun(appId, env, config, commitSha);
    } catch {
      continue; // GH API transient error — retry on next poll
    }
    if (status) {
      await onStatus(status);
      return status;
    }
  }
  return null;
}

/**
 * The failure reason from a failed run's job and log, reason first: the
 * session's deployLog and errors keep 500 chars, and the admin inspector shows
 * those, so the failing step and error lines must come before the detail.
 */
async function fetchCIFailureDetails(ghApi: ReturnType<typeof makeGhApi>, repo: string, runId: number, token: string): Promise<string> {
  const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
  try {
    const jobs = await ghApi(`/repos/${repo}/actions/runs/${runId}/jobs`);
    const stepLines: string[] = [];
    let failedJobId: number | null = null;
    let failedAt: string | null = null;

    for (const job of jobs.jobs || []) {
      const jobStatus = job.status === "completed" ? job.conclusion : job.status;
      stepLines.push(`Job: ${job.name} — ${jobStatus}`);
      for (const step of job.steps || []) {
        const stepStatus = step.status === "completed" ? step.conclusion : step.status;
        const icon = stepStatus === "success" ? "✓" : stepStatus === "failure" ? "✗" : stepStatus === "skipped" ? "⊘" : "…";
        stepLines.push(`  ${icon} ${step.name}`);
        if (stepStatus === "failure" && !failedAt) failedAt = `${job.name} › ${step.name}`;
      }
      if (jobStatus === "failure" && !failedJobId) failedJobId = job.id;
    }

    // The actual log output of the failed job: most useful info is at the end.
    let logTail = "";
    if (failedJobId) {
      try {
        const logRes = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${failedJobId}/logs`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "VibeCode" },
          redirect: "follow",
        });
        if (logRes.ok) {
          const logText = await logRes.text();
          logTail = logText.length > 1500 ? logText.slice(-1500) : logText;
        }
      } catch {
        // Log fetch failed — step summary is still useful
      }
    }

    const keyLines = keyErrorLines(logTail);
    const lines = [`Build failed${failedAt ? ` at ${failedAt}` : ""} (run ${runId})`];
    if (keyLines.length) lines.push(...keyLines);
    lines.push(`Run: ${runUrl}`, "", ...stepLines);
    if (logTail) lines.push("", "--- Failed job log (tail) ---", logTail);
    return lines.join("\n").slice(0, 4000);
  } catch {
    return `GitHub Actions deploy failed. Check: ${runUrl}`;
  }
}

/** The last few error-looking lines of a GitHub Actions log, without timestamps. */
export function keyErrorLines(log: string, max = 5): string[] {
  return log
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "").trim())
    .filter((line) => /\berror\b|ERR!|failed|✘|Cannot find|is not assignable|Unexpected token/i.test(line))
    .filter((line) => !/^##\[group\]|Process completed with exit code/.test(line))
    .slice(-max);
}

async function hasMainBranch(repoId: string, token: string, config: StoreConfig): Promise<boolean> {
  const ghApi = makeGhApi(token, config.agentName);
  const repo = `${config.org}/${repoId}`;
  const ref = (await ghApi(`/repos/${repo}/git/ref/heads/main`)) as GhResponse;
  const status = apiStatus(ref, ref.object?.sha ? 200 : 404);
  if (status === 404) return false;
  if (status === 409 && /^Git Repository is empty\.?$/i.test(ref.message?.trim() ?? "")) return false;
  if (status !== 200) throw new Error(`GitHub could not check ${repo} main (${status}): ${ref.message || "unknown error"}`);
  if (!ref.object?.sha) throw new Error(`GitHub returned an invalid main ref for ${repo}.`);
  return true;
}

function initialCommitMessage(repoId: string): string {
  return `${INITIAL_COMMIT_PREFIX}${repoId}`;
}

async function isBootstrapCommitOnly(
  repo: string,
  initialPath: string,
  initialContent: string,
  baselineFiles: Map<string, string>,
  ghApi: ReturnType<typeof makeGhApi>,
): Promise<boolean> {
  const ref = (await ghApi(`/repos/${repo}/git/ref/heads/main`)) as GhResponse;
  const refStatus = apiStatus(ref, ref.object?.sha ? 200 : 404);
  if (refStatus === 404) return false;
  if (refStatus !== 200) throw new Error(`GitHub could not inspect ${repo} main (${refStatus}): ${ref.message || "unknown error"}`);
  const headSha = ref.object?.sha as string | undefined;
  if (!headSha) throw new Error(`GitHub returned an invalid main ref for ${repo}.`);

  const commit = (await ghApi(`/repos/${repo}/git/commits/${headSha}`)) as GhResponse;
  if (apiStatus(commit, commit.tree?.sha ? 200 : 404) !== 200 || !commit.tree?.sha) return false;
  const message = typeof commit.message === "string" ? commit.message.split("\n")[0] : "";
  if (message !== initialCommitMessage(repo.split("/").at(-1) ?? "") || (commit.parents?.length ?? 0) !== 0) return false;

  const tree = (await ghApi(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`)) as GhResponse;
  if (apiStatus(tree, Array.isArray(tree.tree) ? 200 : 404) !== 200 || tree.truncated || !Array.isArray(tree.tree)) return false;
  if (tree.tree.length !== 1 || tree.tree[0]?.path !== initialPath || tree.tree[0]?.type !== "blob") return false;
  if (baselineFiles.get(initialPath) !== initialContent) return false;

  const file = (await ghApi(`/repos/${repo}/contents/${contentsPath(initialPath)}?ref=main`)) as GhResponse;
  if (apiStatus(file, typeof file.content === "string" ? 200 : 404) !== 200 || file.encoding !== "base64") return false;
  try {
    return decodeBase64Utf8(file.content) === initialContent;
  } catch {
    return false;
  }
}

async function hasScaffoldTree(repo: string, baselineFiles: Map<string, string>, ghApi: ReturnType<typeof makeGhApi>): Promise<boolean> {
  const ref = (await ghApi(`/repos/${repo}/git/ref/heads/main`)) as GhResponse;
  const status = apiStatus(ref, ref.object?.sha ? 200 : 404);
  if (status !== 200 || !ref.object?.sha) return false;
  const commit = (await ghApi(`/repos/${repo}/git/commits/${ref.object.sha}`)) as GhResponse;
  if (!commit.tree?.sha) return false;
  const tree = (await ghApi(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`)) as GhResponse;
  if (apiStatus(tree, Array.isArray(tree.tree) ? 200 : 404) !== 200 || tree.truncated || !Array.isArray(tree.tree)) return false;
  const blobs = new Map(tree.tree.filter((item: TreeItem) => item.type === "blob").map((item: TreeItem) => [item.path, item.sha]));
  for (const [path, content] of baselineFiles) {
    if (blobs.get(path) !== (await gitBlobSha(content))) return false;
  }
  return true;
}

/** Initialize an empty repository with a real scaffold file using Contents API,
 * then let Git Data API commit the full scaffold. A conflict is recoverable only
 * when this exact initializer or the complete scaffold is present afterward. */
async function initializeEmptyRepo(
  repo: string,
  repoId: string,
  initialPath: string,
  initialContent: string,
  baselineFiles: Map<string, string>,
  ghApi: ReturnType<typeof makeGhApi>,
): Promise<boolean> {
  const put = (await ghApi(`/repos/${repo}/contents/${contentsPath(initialPath)}`, "PUT", {
    message: initialCommitMessage(repoId),
    content: encodeBase64Utf8(initialContent),
  })) as GhResponse;
  const status = apiStatus(put, put.commit?.sha && put.content?.sha ? 201 : 0);
  if ((status === 200 || status === 201) && put.commit?.sha && put.content?.sha) return true;

  if (status === 409 || status === 422) {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await isBootstrapCommitOnly(repo, initialPath, initialContent, baselineFiles, ghApi)) return true;
      if (await hasScaffoldTree(repo, baselineFiles, ghApi)) return false;
      await sleep(100);
    }
    throw new Error(
      `Repository ${repo} changed while its initial scaffold was being created; no files were overwritten. Retry after checking main.`,
    );
  }

  throw new Error(
    `Failed to initialize empty repository ${repo} (${status || "unknown status"}): ${put.message || "GitHub did not create the first commit"}`,
  );
}

/** Commit a file patch via the Git Data API. Existing repos always use
 *  base_tree so unmentioned platform-owned files survive. */
async function commitPatchToGitHub(repoId: string, files: FileDelta, message: string, token: string, config: StoreConfig): Promise<string> {
  const ghApi = makeGhApi(token, config.agentName);
  const repo = `${config.org}/${repoId}`;

  const ref = await ghApi(`/repos/${repo}/git/ref/heads/main`);
  const parentSha = ref.object?.sha as string | undefined;
  const treeItems = await createTreeItems(ghApi, repo, files);
  let baseTree: string | undefined;
  if (parentSha) {
    const parentCommit = await ghApi(`/repos/${repo}/git/commits/${parentSha}`);
    if (!parentCommit.tree?.sha) throw new Error(`Failed to read parent tree for ${repo}: ${parentCommit.message || "unknown error"}`);
    baseTree = parentCommit.tree.sha;
  }

  const tree = await ghApi(`/repos/${repo}/git/trees`, "POST", {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: treeItems,
  });
  if (!tree.sha) throw new Error(`Failed to create tree: ${tree.message || "unknown error"}`);

  const commit = await ghApi(`/repos/${repo}/git/commits`, "POST", {
    message,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  });
  if (!commit.sha) throw new Error(`Failed to create commit: ${commit.message || "unknown error"}`);

  const refUpdate = parentSha
    ? await ghApi(`/repos/${repo}/git/refs/heads/main`, "PATCH", { sha: commit.sha })
    : await ghApi(`/repos/${repo}/git/refs`, "POST", { ref: "refs/heads/main", sha: commit.sha });

  // Check the result: a rejected push (e.g. missing `workflow` token scope for
  // .github/workflows/deploy.yml, or a non-fast-forward) must not be swallowed.
  if (!refUpdate.ref) {
    throw new Error(`Failed to update main ref for ${repo}: ${refUpdate.message || "unknown error"}`);
  }
  return commit.sha;
}

/** Push an update to an existing repo (new commit on top of existing). */
export async function pushUpdate(
  appId: string,
  files: Map<string, string>,
  baselineFiles: Map<string, string>,
  commitMessage: string,
  env: DeployEnv,
  config: StoreConfig,
): Promise<PushUpdateResult> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const repo = `${config.org}/${appId}`;
  const delta = computeFileDelta(files, baselineFiles);
  if (delta.size === 0) {
    return {
      ok: true,
      skipped: true,
      message: `No agent-authored changes to push for ${repo}; platform scaffold and current app files are unchanged.`,
    };
  }

  const ref = await ghApi(`/repos/${repo}/git/ref/heads/main`);
  const parentSha = ref.object?.sha;
  if (!parentSha) return { ok: false, message: `Error: could not find HEAD for ${repo}. Is the ${config.noun} deployed?` };

  let treeItems: TreeItem[];
  try {
    treeItems = await createTreeItems(ghApi, repo, delta);
  } catch (e) {
    return { ok: false, message: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }

  const parentCommit = await ghApi(`/repos/${repo}/git/commits/${parentSha}`);
  if (!parentCommit.tree?.sha) return { ok: false, message: `Error: could not read parent commit tree for ${repo}.` };

  const tree = await ghApi(`/repos/${repo}/git/trees`, "POST", {
    base_tree: parentCommit.tree.sha,
    tree: treeItems,
  });

  const commit = await ghApi(`/repos/${repo}/git/commits`, "POST", {
    message: commitMessage,
    tree: tree.sha,
    parents: [parentSha],
  });

  const refUpdate = await ghApi(`/repos/${repo}/git/refs/heads/main`, "PATCH", {
    sha: commit.sha,
  });
  if (!refUpdate.ref) return { ok: false, message: `Error: failed to update ref for ${repo}: ${refUpdate.message || "unknown"}` };
  if (!commit.sha) return { ok: false, message: `Error: GitHub did not return a commit sha for ${repo}.` };

  return {
    ok: true,
    message: `Pushed update to ${repo} (${commit.sha.slice(0, 7)}): ${deltaDetail(delta)}. GitHub Actions will deploy to R2.`,
    commitSha: commit.sha,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
