/** Infra query tools — read-only operations against GitHub and audit APIs. */

import type { StoreConfig } from "./config";
import type { DeployEnv } from "./deploy";
import { makeGhApi } from "./github";

/** Check the latest deployment status via GitHub Actions. */
export async function checkDeployStatus(appId: string, env: DeployEnv, config: StoreConfig): Promise<string> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const repo = `${config.org}/${appId}`;
  const runs = await ghApi(`/repos/${repo}/actions/runs?per_page=1`);
  if (!runs.workflow_runs?.length) {
    return `No workflow runs found for ${repo}. The ${config.noun} may not have been deployed yet.`;
  }
  const latestRun = runs.workflow_runs[0];
  const runStatus = latestRun.status === "completed" ? latestRun.conclusion : latestRun.status;
  const appUrl = `https://${appId}.${config.domain}`;
  const created = latestRun.created_at ? new Date(latestRun.created_at).toISOString() : "unknown";
  return `Latest deploy: ${runStatus}\nURL: ${appUrl}\nCreated: ${created}\nWorkflow: ${latestRun.name || "unknown"}`;
}

/** List all items from the store registry. */
export async function listDeployed(env: DeployEnv, config: StoreConfig): Promise<string> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const file = await ghApi(`/repos/${config.org}/${config.storeRepo}/contents/${config.registryPath}`);
  if (!file.content) return "Could not read registry.";
  const rawBytes = Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  const registry = JSON.parse(new TextDecoder().decode(rawBytes));
  const items = registry[config.nounPlural] || [];
  if (items.length === 0) return `No ${config.nounPlural} deployed yet.`;
  return items
    .map((a: { id: string; name: string; category: string; appUrl: string }) => `${a.id} — ${a.name} (${a.category}) ${a.appUrl}`)
    .join("\n");
}

/** Fetch a URL and return the response. Redirects are not followed to prevent SSRF bypass. */
export async function fetchUrl(url: string, method: string, agentName: string): Promise<string> {
  try {
    const httpRes = await fetch(url, { method, headers: { "User-Agent": agentName }, redirect: "manual" });
    if (httpRes.status >= 300 && httpRes.status < 400) {
      const location = httpRes.headers.get("Location") || "(none)";
      return `${httpRes.status} Redirect → ${location}\n(Redirects are not followed for security.)`;
    }
    const responseBody = await httpRes.text();
    return `${httpRes.status} ${httpRes.statusText}\n${responseBody.slice(0, 2000)}`;
  } catch (err) {
    return `Fetch error: ${err}`;
  }
}

/** Get GitHub Actions build logs for the latest workflow run. */
export async function getBuildLogs(appId: string, env: DeployEnv, config: StoreConfig): Promise<string> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const repo = `${config.org}/${appId}`;
  const runs = await ghApi(`/repos/${repo}/actions/runs?per_page=1`);
  if (!runs.workflow_runs?.length) return `No workflow runs found for ${repo}.`;
  const latestRun = runs.workflow_runs[0];
  const runStatus = latestRun.status === "completed" ? latestRun.conclusion : latestRun.status;

  // Fetch jobs for this run to get step-level detail
  const jobs = await ghApi(`/repos/${repo}/actions/runs/${latestRun.id}/jobs`);
  const jobLines: string[] = [];
  for (const job of jobs.jobs || []) {
    const jobStatus = job.status === "completed" ? job.conclusion : job.status;
    jobLines.push(`Job: ${job.name} — ${jobStatus}`);
    for (const step of job.steps || []) {
      const stepStatus = step.status === "completed" ? step.conclusion : step.status;
      const icon = stepStatus === "success" ? "✓" : stepStatus === "failure" ? "✗" : "…";
      jobLines.push(`  ${icon} ${step.name}`);
    }
  }

  return `Run ${String(latestRun.id).slice(0, 8)} — workflow: ${latestRun.name}, status: ${runStatus}\n\n${jobLines.join("\n") || "(no job details)"}`;
}

/** Get GitHub Actions CI check results for a repo. */
export async function getCIResults(appId: string, env: DeployEnv, config: StoreConfig): Promise<string> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const repo = `${config.org}/${appId}`;
  const runs = await ghApi(`/repos/${repo}/commits/main/check-runs`);
  if (!runs.check_runs?.length) return `No CI check runs found for ${repo}. CI may not have run yet.`;

  const results = runs.check_runs.map(
    (r: { status: string; conclusion: string | null; name: string; output?: { summary?: string; text?: string } }) => {
      // conclusion can be null for a completed run (e.g. action_required/stale);
      // fall back to "pending" so status.toUpperCase() below never throws.
      const status = (r.status === "completed" ? r.conclusion : r.status) ?? "pending";
      let detail = "";
      if (r.output?.summary) detail = r.output.summary.slice(0, 200);
      else if (r.output?.text) detail = r.output.text.slice(0, 200);
      return `${status === "success" ? "PASS" : status === "failure" ? "FAIL" : status.toUpperCase()}: ${r.name}${detail ? ` — ${detail}` : ""}`;
    },
  );

  return `CI results for ${repo} (${runs.check_runs.length} checks):\n${results.join("\n")}`;
}

/** Get quality audit results from the store's audit API. */
export async function getAuditResults(appId: string, config: StoreConfig): Promise<string> {
  try {
    // Audit rows for BOTH stores live in the FAS backend's audit_results table
    // (packages/backend/src/lib/audit.ts scans apps and games). There is no
    // api.freegamestore.online — that hostname lands on the FGS host worker,
    // which 404s "no game registered" (#450).
    const auditRes = await fetch(`https://api.freeappstore.online/v1/audit?store=${config.store}&app=${appId}`, {
      headers: { "User-Agent": config.agentName },
    });
    if (!auditRes.ok) return `Audit API returned ${auditRes.status}. The ${config.noun} may not have been audited yet.`;
    const auditData = (await auditRes.json()) as {
      summary?: { appId: string; pass: number; warn: number; fail: number }[];
      checks?: { checkName: string; status: string; detail?: string | null }[];
      total?: number;
    };

    const s = auditData.summary?.find((row) => row.appId === appId);
    if (s) {
      const lines = [`Audit for ${appId}: ${s.pass} pass, ${s.warn} warn, ${s.fail} fail`];
      const checks = auditData.checks ?? [];
      for (const c of checks) {
        const icon = c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL";
        lines.push(`  ${icon}: ${c.checkName}${c.detail ? ` — ${c.detail}` : ""}`);
      }
      if (auditData.total && auditData.total > checks.length) {
        lines.push(`  (showing ${checks.length} of ${auditData.total} checks)`);
      }
      return lines.join("\n");
    }

    return JSON.stringify(auditData, null, 2).slice(0, 2000);
  } catch (err) {
    return `Could not reach audit API: ${err}`;
  }
}
