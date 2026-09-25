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

type TreeItem = { path: string; mode: string; type: string; sha: string | null };
export type FileDelta = Map<string, string | null>;
export type PushUpdateResult =
  | { ok: true; message: string; commitSha: string; skipped?: false }
  | { ok: true; message: string; skipped: true; commitSha?: undefined }
  | { ok: false; message: string };
type WorkflowRun = { id: number; status?: string; conclusion?: string | null; head_sha?: string };

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
  const repoCheck = await ghApi(`/repos/${config.org}/${deployConfig.id}`);
  if (repoCheck.id) {
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
  } else {
    const createRepo = await ghApi(`/orgs/${config.org}/repos`, "POST", {
      name: deployConfig.id,
      private: false,
      description: (deployConfig.description || "").slice(0, 200),
      auto_init: false,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    });
    if (createRepo.id) {
      steps.push({ name: "GitHub repo", status: "ok", detail: `Created ${config.org}/${deployConfig.id}` });
    } else {
      steps.push({ name: "GitHub repo", status: "fail", detail: createRepo.message || "Failed" });
      await onStatus({ phase: "error", error: `GitHub repo creation failed: ${createRepo.message}` });
      return;
    }
  }
  await onStatus({ phase: "provisioning", steps: [...steps] });

  // Step 2: ensure the platform scaffold exists, then push only the
  // agent-authored delta. This preserves workflow/lockfile/icon/analytics/SDK
  // files generated by provisioning while still deploying the app code.
  const repoHasMain = await hasMainBranch(deployConfig.id, env.GITHUB_TOKEN, config);
  let buildCommitSha: string | undefined;
  if (!repoHasMain && baselineFiles.size > 0) {
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

export async function waitForGitHubDeploy(
  appId: string,
  env: DeployEnv,
  config: StoreConfig,
  onStatus: (status: DeployStatus) => void | Promise<void>,
  commitSha?: string,
): Promise<void> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const appUrl = `https://${appId}.${config.domain}`;
  const repo = `${config.org}/${appId}`;
  await onStatus({ phase: "building", deployUrl: appUrl });

  const deadline = Date.now() + 150_000; // 2.5 min
  while (Date.now() < deadline) {
    await sleep(8000);
    try {
      const runs = await ghApi(`/repos/${repo}/actions/runs?per_page=10`);
      const workflowRuns = (runs.workflow_runs || []) as WorkflowRun[];
      const latestRun = commitSha ? workflowRuns.find((run) => run.head_sha === commitSha) : workflowRuns[0];
      if (!latestRun) continue;
      if (latestRun.status !== "completed") continue;

      if (latestRun.conclusion === "success") {
        await onStatus({ phase: "live", appUrl });
        return;
      }
      if (latestRun.conclusion === "failure") {
        const errorDetail = await fetchCIFailureDetails(ghApi, repo, latestRun.id, env.GITHUB_TOKEN);
        await onStatus({ phase: "error", error: errorDetail });
        return;
      }
      if (latestRun.conclusion) {
        await onStatus({
          phase: "error",
          error: `GitHub Actions deploy ended with ${latestRun.conclusion}. Check: https://github.com/${repo}/actions`,
        });
        return;
      }
    } catch {
      /* GH API transient error — retry on next poll */
    }
  }
  await onStatus({ phase: "live", appUrl }); // timeout — assume deploying
}

/** Fetch detailed step-level failure info from a failed GitHub Actions run. */
async function fetchCIFailureDetails(ghApi: ReturnType<typeof makeGhApi>, repo: string, runId: number, token: string): Promise<string> {
  try {
    const jobs = await ghApi(`/repos/${repo}/actions/runs/${runId}/jobs`);
    const lines: string[] = [`Deploy failed (run ${runId})`];
    let failedJobId: number | null = null;

    for (const job of jobs.jobs || []) {
      const jobStatus = job.status === "completed" ? job.conclusion : job.status;
      lines.push(`Job: ${job.name} — ${jobStatus}`);
      for (const step of job.steps || []) {
        const stepStatus = step.status === "completed" ? step.conclusion : step.status;
        const icon = stepStatus === "success" ? "✓" : stepStatus === "failure" ? "✗" : stepStatus === "skipped" ? "⊘" : "…";
        lines.push(`  ${icon} ${step.name}`);
      }
      if (jobStatus === "failure" && !failedJobId) failedJobId = job.id;
    }

    // Try to fetch the actual log output of the failed job
    if (failedJobId) {
      try {
        const logRes = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${failedJobId}/logs`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "VibeCode" },
          redirect: "follow",
        });
        if (logRes.ok) {
          const logText = await logRes.text();
          // Extract last 1500 chars — most useful error info is at the end
          const tail = logText.length > 1500 ? logText.slice(-1500) : logText;
          lines.push("\n--- Failed job log (tail) ---");
          lines.push(tail);
        }
      } catch {
        // Log fetch failed — step summary is still useful
      }
    }

    return lines.join("\n").slice(0, 4000);
  } catch {
    return `GitHub Actions deploy failed. Check: https://github.com/${repo}/actions`;
  }
}

async function hasMainBranch(repoId: string, token: string, config: StoreConfig): Promise<boolean> {
  const ghApi = makeGhApi(token, config.agentName);
  const repo = `${config.org}/${repoId}`;
  const ref = await ghApi(`/repos/${repo}/git/ref/heads/main`);
  return !!ref.object?.sha;
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
