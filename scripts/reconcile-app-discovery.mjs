/** Promote only explicitly pending FAS listings; legacy/live entries never depend on a health probe. */
import { pathToFileURL } from 'node:url';
import discovery from '../sites/storefront/lib/discovery.cjs';

const REPOSITORY = 'freeappstore-online/platform';
const REGISTRY = 'sites/storefront/registry.json';
const REGISTRY_API = `/repos/${REPOSITORY}/contents/${REGISTRY}`;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export function githubClient(token, transport = fetch) {
  return async (path, method = 'GET', body) => {
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com' || url.username || url.password)
      throw new Error('GitHub credentials require api.github.com');
    const response = await transport(url, {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'fas-discovery',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 409) return { conflict: true };
    if (!response.ok) throw new Error(`GitHub ${method} ${url.pathname}: HTTP ${response.status}`);
    return response.status === 204 ? {} : response.json();
  };
}

function validLaunchUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^[a-z0-9][a-z0-9.-]*\.freeappstore\.online$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function validCandidate(app) {
  const text = (value, max) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    );
  return (
    discovery.isPendingListing(app) &&
    /^[a-z0-9][a-z0-9-]*$/.test(app.id) &&
    text(app.name, 80) &&
    validLaunchUrl(app.appUrl) &&
    /^[\w.-]+\/[\w.-]+$/.test(app.repo || '') &&
    (app.category == null || text(app.category, 80)) &&
    (app.description == null || text(app.description, 500)) &&
    (app.developer == null || text(app.developer, 60)) &&
    (!app.iconBg || /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(app.iconBg))
  );
}

function latestDeployment(runs) {
  return runs.find(
    (run) =>
      run.head_branch === 'main' &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      /(?:^|\/)(?:deploy(?:-production|-prod)?|ci)\.ya?ml$/.test((run.path || '').split('@')[0]) &&
      /deploy/i.test(run.name || '') &&
      !/preview|staging/i.test(run.name),
  );
}

const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)].map((match) => [
      match[1].toLowerCase(),
      match[2] ?? match[3] ?? match[4],
    ]),
  );
const noindex = (value) => /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/i.test(value || '');
const normalizeUrl = (raw) => {
  const url = new URL(raw);
  url.hash = '';
  return url.href;
};

/** This transport is deliberately separate from githubClient: no GitHub authorization reaches an app. */
export async function healthyIndexableLaunch(raw, transport = fetch) {
  let url = raw;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!validLaunchUrl(url)) return false;
    const response = await transport(url, {
      redirect: 'manual',
      headers: { Accept: 'text/html', 'User-Agent': 'fas-discovery' },
      signal: AbortSignal.timeout(15000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return false;
      url = new URL(location, url).href;
      continue;
    }
    if (
      response.status !== 200 ||
      !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') ||
      noindex(response.headers.get('x-robots-tag'))
    )
      return false;
    const reader = response.body?.getReader();
    if (!reader) return false;
    let bytes = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString('utf8');
    if (!/<(?:!doctype\s+html|html|head|body)\b/i.test(html)) return false;
    for (const match of html.matchAll(/<(meta|link)\b[^>]*>/gi)) {
      const attr = attributes(match[0]);
      if (
        match[1].toLowerCase() === 'meta' &&
        ['robots', 'googlebot'].includes((attr.name || '').toLowerCase()) &&
        noindex(attr.content)
      )
        return false;
      if (
        match[1].toLowerCase() === 'link' &&
        (attr.rel || '').toLowerCase().split(/\s+/).includes('canonical')
      ) {
        try {
          if (
            normalizeUrl(new URL((attr.href || '').replaceAll('&amp;', '&'), url)) !==
            normalizeUrl(url)
          )
            return false;
        } catch {
          return false;
        }
      }
    }
    // No canonical/description requirement: host metadata appears only AFTER public discovery.
    return true;
  }
  return false;
}

const fingerprint = (app) =>
  JSON.stringify([
    app.id,
    app.appUrl,
    app.repo,
    app.status,
    app.visibility,
    app.private,
    app.discoveryStatus,
    app.discoveryRequestedAt,
  ]);
const decode = (file) =>
  JSON.parse(Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'));

// A receipt survives a lost dispatch answer or a process stopping after its registry commit.
// The next run retries delivery; it never needs to republish or health-probe live apps.
async function deliverPromotions(github) {
  const first = decode(await github(`${REGISTRY_API}?ref=main`));
  const pending = new Map(
    first.apps
      .filter((app) => discovery.isPublicListing(app) && app.discoveryDeliveryPending)
      .map((app) => [app.id, app.discoveryDeliveryPending]),
  );
  if (!pending.size) return;
  await github(`/repos/${REPOSITORY}/actions/workflows/deploy-storefront.yml/dispatches`, 'POST', {
    ref: 'main',
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await github(`${REGISTRY_API}?ref=main`);
    const registry = decode(file);
    let changed = false;
    for (const app of registry.apps) {
      if (
        !pending.has(app.id) ||
        pending.get(app.id) !== app.discoveryDeliveryPending ||
        !discovery.isPublicListing(app)
      )
        continue;
      delete app.discoveryDeliveryPending;
      changed = true;
    }
    if (!changed) return;
    const result = await github(REGISTRY_API, 'PUT', {
      branch: 'main',
      sha: file.sha,
      message: 'Record storefront discovery delivery request',
      content: Buffer.from(`${JSON.stringify(registry, null, 2)}\n`).toString('base64'),
    });
    if (!result.conflict) return;
  }
  throw new Error('Storefront delivery was requested; registry receipt cleanup will retry');
}

export async function reconcileDiscovery(github, transport = fetch) {
  const initial = await github(`${REGISTRY_API}?ref=main`);
  const registry = decode(initial);
  if (registry.apps.some((app) => app.discoveryDeliveryPending && discovery.isPublicListing(app)))
    await deliverPromotions(github);
  const ready = new Map();
  const skipped = [];
  for (const app of registry.apps || []) {
    if (!validCandidate(app)) continue;
    try {
      const runs = await github(`/repos/${app.repo}/actions/runs?branch=main&per_page=100`);
      const latest = latestDeployment(runs.workflow_runs || []);
      if (latest?.status !== 'completed' || latest.conclusion !== 'success') {
        skipped.push(app.id);
        continue;
      }
      const head = await github(`/repos/${app.repo}/commits/main`);
      if (head.sha !== latest.head_sha || !(await healthyIndexableLaunch(app.appUrl, transport))) {
        skipped.push(app.id);
        continue;
      }
      ready.set(app.id, fingerprint(app));
    } catch (error) {
      console.warn(`Discovery remains pending for ${app.id}: ${error.message}`);
      skipped.push(app.id);
    }
  }
  if (ready.size === 0) return { promoted: [], skipped };
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await github(`${REGISTRY_API}?ref=main`);
    const current = decode(file);
    const promoted = [];
    for (const app of current.apps || []) {
      if (!validCandidate(app) || ready.get(app.id) !== fingerprint(app)) continue;
      app.discoveryStatus = 'live';
      app.discoveryDeliveryPending = crypto.randomUUID();
      promoted.push(app.id);
    }
    if (promoted.length === 0) return { promoted, skipped };
    const result = await github(REGISTRY_API, 'PUT', {
      branch: 'main',
      sha: file.sha,
      message: `Publish deployed app listings: ${promoted.join(', ')}`,
      content: Buffer.from(`${JSON.stringify(current, null, 2)}\n`).toString('base64'),
    });
    if (result.conflict) continue;
    // GITHUB_TOKEN writes do not start push workflows. A durable receipt makes dispatch retryable.
    await deliverPromotions(github);
    return { promoted, skipped };
  }
  throw new Error('Registry changed during promotion; retry without overwriting another writer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
  console.log(JSON.stringify(await reconcileDiscovery(githubClient(process.env.GITHUB_TOKEN))));
}
