#!/usr/bin/env node
/**
 * Live check for the shared app host (#308). A Worker upload is not recovery:
 * every public app root must answer, representative JS assets must load, the
 * console must load, an unknown host must 404, and the API must be healthy.
 * Default apps must not gain COOP/COEP.
 */
import { pathToFileURL } from 'node:url';

const DEFAULTS = {
  registryUrl: 'https://freeappstore.online/registry.json',
  healthUrl: 'https://api.freeappstore.online/health',
  consoleUrl: 'https://console.freeappstore.online/',
  unknownHostUrl: 'https://no-such-app-issue-308.freeappstore.online/',
  representativeAssets: 3,
  concurrency: 8,
  timeoutMs: 15000,
};

export function workerFailure(status, body) {
  const text = String(body ?? '').slice(0, 4000);
  if (status >= 500) return `HTTP ${status}`;
  if (/error\s*1101/i.test(text) || /worker threw exception/i.test(text)) return 'cloudflare 1101';
  return null;
}

export function hasCrossOriginIsolation(headers) {
  const coop = headers.get('cross-origin-opener-policy');
  const coep = headers.get('cross-origin-embedder-policy');
  const policy = headers.get('permissions-policy') ?? '';
  return Boolean(coop || coep || /cross-origin-isolated=\(self\)/.test(policy));
}

export function localScriptSrc(html) {
  const pattern = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const src = match[1];
    // App hosts emit `/assets/….js`. The console emits `./assets/….js`: Vite's
    // relative base, so the same HTML works at console.freeappstore.online/
    // and at freeappstore.online/app/.
    if (/^(?:\.\/|\/)assets\/[^/?#]+\.js(?:[?#].*)?$/.test(src)) return src;
  }
  return null;
}

export function assessRoot(status, body, headers, allowIsolation) {
  const crashed = workerFailure(status, body);
  if (crashed) return crashed;
  if (status !== 200) return `HTTP ${status}`;
  const type = headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return `content-type ${type || 'missing'}`;
  if (!allowIsolation && hasCrossOriginIsolation(headers)) {
    return 'COOP/COEP set on a default app';
  }
  return null;
}

export function assessAsset(status, body, headers, allowIsolation) {
  const crashed = workerFailure(status, body);
  if (crashed) return crashed;
  if (status !== 200) return `HTTP ${status}`;
  const type = headers.get('content-type') ?? '';
  if (!/javascript/i.test(type)) return `content-type ${type || 'missing'}`;
  if (!allowIsolation && hasCrossOriginIsolation(headers)) {
    return 'COOP/COEP set on a default app asset';
  }
  return null;
}

export function assessUnknownHost(status, body) {
  const crashed = workerFailure(status, body);
  if (crashed) return crashed;
  if (status !== 404) return `HTTP ${status}`;
  if (!String(body).includes('no app registered')) {
    return '404 body is not the host unknown-app response';
  }
  return null;
}

async function readResponse(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function appIdOf(app) {
  return typeof app?.id === 'string' ? app.id : '';
}

export async function verifyAppHost(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const registryUrl = options.registryUrl ?? DEFAULTS.registryUrl;
  const healthUrl = options.healthUrl ?? DEFAULTS.healthUrl;
  const consoleUrl = options.consoleUrl ?? DEFAULTS.consoleUrl;
  const unknownHostUrl = options.unknownHostUrl ?? DEFAULTS.unknownHostUrl;
  const representativeAssets = options.representativeAssets ?? DEFAULTS.representativeAssets;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const failures = [];
  const note = (scope, reason) => failures.push(`${scope}: ${reason}`);

  const health = await readResponse(fetchImpl, healthUrl, timeoutMs);
  const healthCrash = workerFailure(health.status, health.body);
  if (healthCrash || health.status !== 200)
    note('api /health', healthCrash || `HTTP ${health.status}`);

  const registryResponse = await readResponse(fetchImpl, registryUrl, timeoutMs);
  let apps = [];
  const registryCrash = workerFailure(registryResponse.status, registryResponse.body);
  if (registryCrash || registryResponse.status !== 200) {
    note('registry', registryCrash || `HTTP ${registryResponse.status}`);
  } else {
    try {
      const parsed = JSON.parse(registryResponse.body);
      apps = Array.isArray(parsed.apps) ? parsed.apps : [];
    } catch {
      note('registry', 'body is not the public app registry');
    }
  }
  if (apps.length === 0) note('registry', 'no public apps to check');

  const unknown = await readResponse(fetchImpl, unknownHostUrl, timeoutMs);
  const unknownReason = assessUnknownHost(unknown.status, unknown.body);
  if (unknownReason) note(`unknown host ${unknownHostUrl}`, unknownReason);

  const consolePage = await readResponse(fetchImpl, consoleUrl, timeoutMs);
  const consoleReason = assessRoot(
    consolePage.status,
    consolePage.body,
    consolePage.headers,
    false,
  );
  if (consoleReason) note(`console ${consoleUrl}`, consoleReason);
  const consoleScript = localScriptSrc(consolePage.body);
  if (!consoleReason && !consoleScript)
    note(`console ${consoleUrl}`, 'root has no local /assets JS');
  if (consoleScript) {
    const assetUrl = new URL(consoleScript, consoleUrl).href;
    const asset = await readResponse(fetchImpl, assetUrl, timeoutMs);
    const assetReason = assessAsset(asset.status, asset.body, asset.headers, false);
    if (assetReason) note(`console asset ${assetUrl}`, assetReason);
  }

  const roots = await mapPool(apps, concurrency, async (app, index) => {
    const id = appIdOf(app);
    const url = `https://${id}.freeappstore.online/`;
    if (!id) {
      note('registry app', 'missing id');
      return null;
    }
    try {
      const page = await readResponse(fetchImpl, url, timeoutMs);
      const reason = assessRoot(
        page.status,
        page.body,
        page.headers,
        app.crossOriginIsolated === true,
      );
      if (reason) note(`${id} ${url}`, reason);
      if ((index + 1) % 20 === 0) log(`checked ${index + 1}/${apps.length} app roots`);
      return { app, url, page, reason };
    } catch (error) {
      note(`${id} ${url}`, error instanceof Error ? error.message : String(error));
      return null;
    }
  });

  const assetCandidates = roots.filter(
    (root) =>
      root &&
      !root.reason &&
      root.app.crossOriginIsolated !== true &&
      localScriptSrc(root.page.body),
  );
  const sample = assetCandidates.slice(0, representativeAssets);
  const defaultApps = apps.filter((app) => app.crossOriginIsolated !== true);
  if (defaultApps.length > 0 && sample.length === 0) {
    note('js assets', 'no default app root served a local /assets script');
  }
  for (const root of sample) {
    const src = localScriptSrc(root.page.body);
    const assetUrl = new URL(src, root.url).href;
    try {
      const asset = await readResponse(fetchImpl, assetUrl, timeoutMs);
      const reason = assessAsset(asset.status, asset.body, asset.headers, false);
      if (reason) note(`${appIdOf(root.app)} asset ${assetUrl}`, reason);
      else log(`asset ${assetUrl} ok`);
    } catch (error) {
      note(
        `${appIdOf(root.app)} asset ${assetUrl}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const summary = `checked ${apps.length} app roots, ${sample.length} js assets, console, unknown host, api health; ${failures.length} failures`;
  log(summary);
  return {
    ok: failures.length === 0,
    failures,
    summary,
    checkedRoots: apps.length,
    checkedAssets: sample.length,
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const result = await verifyAppHost();
  for (const failure of result.failures) console.error(failure);
  process.exit(result.ok ? 0 : 1);
}
