#!/usr/bin/env node
// Read-only fleet consistency audit (#552). It compares what exists in the org,
// the storefront registry, the live sites, the platform database (through the
// admin API, when a credential is provided) and each repo's own files, and
// reports every disagreement. It never writes to a repo, the registry or D1.
//
//   node scripts/fleet-consistency-audit.mjs [--report <file>]
//
// Env: GITHUB_TOKEN (read), FAS_AUDIT_ADMIN_TOKEN (optional; a fas session of an
// admin, sent only to api.freeappstore.online/v1/admin/apps; without it the D1
// checks are skipped and said so, see ops/ACCESS.md).

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import discovery from '../sites/storefront/lib/discovery.cjs';

const ORG = 'freeappstore-online';
const DAY_MS = 24 * 60 * 60 * 1000;

/** `owner/name` (lowercase) from a repo reference: a GitHub URL or `owner/name`. */
export function repoRef(ref) {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
    String(ref ?? '').trim(),
  );
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Why a deploy.yml cannot deploy keylessly (the generator's output reads no R2 secret and has id-token: write). */
export function workflowProblems(text) {
  const body = text.replace(/^\s*#.*$/gm, '');
  const problems = [];
  if (/secrets\.R2_/.test(body)) problems.push('reads secrets.R2_*');
  if (!/id-token:\s*write/.test(body)) problems.push('lacks id-token: write');
  return problems;
}

/**
 * Pure comparison of the gathered facts. Returns findings `{ code, id, detail }`.
 *
 *  repos     non-archived org repos: { name, createdAt (ms), empty, deployYml (text|null), fasAppId (string|null) }
 *  registry  storefront registry entries
 *  siteStatus  { [registryId]: HTTP status of the entry's site }
 *  adminApps GET /v1/admin/apps `apps`, or null when the D1 half was skipped
 */
export function auditFleet({
  repos,
  registry,
  allowlist,
  siteStatus = {},
  adminApps = null,
  now = Date.now(),
}) {
  const findings = [];
  const add = (code, id, detail) => findings.push({ code, id, detail });
  const skip = new Set(allowlist);
  const repoByName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  const listed = new Set();

  for (const entry of registry) {
    const ref = repoRef(entry.repo);
    const name = ref?.split('/')[1];
    if (entry.repo && ref !== `${ORG}/${entry.id}`.toLowerCase()) {
      add(
        'registry-repo-mismatch',
        entry.id,
        `registry repo is ${entry.repo}, expected ${ORG}/${entry.id}`,
      );
    }
    if (!name || !repoByName.has(name)) {
      add(
        'registry-without-repo',
        entry.id,
        `no non-archived repo ${ref ?? entry.repo ?? '(none)'} in the org`,
      );
    }
    listed.add(entry.id.toLowerCase());
    if (name) listed.add(name);
    const status = siteStatus[entry.id];
    if (discovery.isPublicListing(entry) && status !== undefined && status !== 200) {
      add('listed-site-not-200', entry.id, `listed app answers HTTP ${status || 'no response'}`);
    }
  }

  for (const repo of repos) {
    const name = repo.name.toLowerCase();
    if (skip.has(name)) continue;
    if (repo.empty) {
      if (now - repo.createdAt > DAY_MS) {
        add('repo-empty', repo.name, 'repo has no commits and is more than 24 hours old');
      }
    } else if (repo.deployYml === null) {
      add('repo-no-deploy-workflow', repo.name, 'no .github/workflows/deploy.yml');
    } else {
      const problems = workflowProblems(repo.deployYml);
      if (problems.length)
        add('repo-legacy-workflow', repo.name, `deploy.yml ${problems.join(' and ')}`);
      if (repo.fasAppId !== null && repo.fasAppId !== repo.name) {
        add('fas-json-appid-mismatch', repo.name, `fas.json appId is ${repo.fasAppId}`);
      }
    }
    if (!listed.has(name)) add('repo-without-registry', repo.name, 'no registry entry');
  }

  if (adminApps) {
    for (const app of adminApps) {
      if (app.owner == null) {
        if (app.hasRoute)
          add('route-without-apps', app.id, 'a routes row exists but there is no apps row (#512)');
        continue;
      }
      if (repoRef(app.repo) !== `${ORG}/${app.id}`.toLowerCase()) {
        add('apps-repo-not-org', app.id, `apps.repo is ${app.repo}, expected ${ORG}/${app.id}`);
      }
      if (!app.hasRoute) add('apps-without-route', app.id, 'apps row without a routes row');
      else if (app.r2Prefix !== `apps/${app.id}`) {
        add('route-prefix-wrong', app.id, `routes.r2_prefix is ${app.r2Prefix}, expected apps/${app.id}`);
      }
    }
    const known = new Set(adminApps.map((a) => a.id));
    for (const repo of repos) {
      const name = repo.name.toLowerCase();
      if (skip.has(name) || repo.empty || repo.deployYml === null) continue;
      if (!known.has(repo.name)) add('repo-without-apps-row', repo.name, 'deployable repo with no apps row');
    }
  }

  return findings.sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
}

export function formatReport(findings, notes = []) {
  if (findings.length === 0 && notes.length === 0) return 'Fleet consistency audit: clean.\n';
  const byCode = new Map();
  for (const f of findings) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f]);
  const lines = [`Fleet consistency audit: ${findings.length} finding(s).`, ''];
  for (const [code, list] of byCode) {
    lines.push(`### ${code} (${list.length})`);
    for (const f of list) lines.push(`- \`${f.id}\`: ${f.detail}`);
    lines.push('');
  }
  for (const note of notes) lines.push(`_Note: ${note}_`);
  return `${lines.join('\n')}\n`;
}

// ── Gathering (network; every call is a GET) ──────────────────────────────

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GET ${new URL(url).pathname}: HTTP ${res.status}`);
  return res.json();
}

async function rawFile(name, path) {
  const res = await fetch(`https://raw.githubusercontent.com/${ORG}/${name}/HEAD/${path}`, {
    signal: AbortSignal.timeout(20000),
  });
  return res.ok ? res.text() : null;
}

async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function listRepos(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fas-fleet-audit',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await getJson(
      `https://api.github.com/orgs/${ORG}/repos?type=all&per_page=100&page=${page}`,
      headers,
    );
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return { repos: repos.filter((r) => !r.archived), headers };
}

async function gatherRepoFacts(repo, headers) {
  const [deployYml, fasJson] = await Promise.all([
    rawFile(repo.name, '.github/workflows/deploy.yml'),
    rawFile(repo.name, 'fas.json'),
  ]);
  let empty = false;
  if (repo.size === 0 && deployYml === null && fasJson === null) {
    // GitHub answers 409 "Git Repository is empty" for a repo with no commits.
    const res = await fetch(`https://api.github.com/repos/${ORG}/${repo.name}/commits?per_page=1`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    empty = res.status === 409;
  }
  let fasAppId = null;
  try {
    fasAppId = fasJson ? (JSON.parse(fasJson).appId ?? null) : null;
  } catch {
    fasAppId = null;
  }
  return { name: repo.name, createdAt: Date.parse(repo.created_at), empty, deployYml, fasAppId };
}

async function siteStatuses(registry) {
  const statuses = {};
  await pool(registry, 10, async (entry) => {
    try {
      const res = await fetch(entry.appUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      statuses[entry.id] = res.status;
    } catch {
      statuses[entry.id] = 0;
    }
  });
  return statuses;
}

async function adminApps(token) {
  const data = await getJson('https://api.freeappstore.online/v1/admin/apps', {
    Authorization: `Bearer ${token}`,
  });
  return data.apps;
}

async function main() {
  const reportIndex = process.argv.indexOf('--report');
  const reportPath = reportIndex > -1 ? process.argv[reportIndex + 1] : null;
  const registry = JSON.parse(readFileSync('sites/storefront/registry.json', 'utf8')).apps;
  const allowlist = JSON.parse(readFileSync('config/non-app-repos.json', 'utf8')).repos;
  const { repos, headers } = await listRepos(process.env.GITHUB_TOKEN);
  const facts = await pool(repos, 10, (repo) => gatherRepoFacts(repo, headers));
  const notes = [];
  let apps = null;
  if (process.env.FAS_AUDIT_ADMIN_TOKEN) {
    apps = await adminApps(process.env.FAS_AUDIT_ADMIN_TOKEN);
  } else {
    notes.push('D1 checks (apps/routes rows) skipped: FAS_AUDIT_ADMIN_TOKEN is not set.');
  }
  const findings = auditFleet({
    repos: facts,
    registry,
    allowlist,
    siteStatus: await siteStatuses(registry),
    adminApps: apps,
  });
  const report = formatReport(findings, notes);
  process.stdout.write(report);
  if (reportPath) writeFileSync(reportPath, report);
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`fleet audit failed: ${e?.message || e}`);
    process.exit(2);
  });
}
