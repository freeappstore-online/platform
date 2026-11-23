import { describe, expect, it } from 'vitest';
import {
  assessAsset,
  assessRoot,
  assessUnknownHost,
  burstApps,
  burstTargets,
  hasCrossOriginIsolation,
  localScriptSrc,
  verifyAppHost,
  workerFailure,
} from './verify-app-host.mjs';

const html = (body: string) =>
  `<!doctype html><html><head>${body}</head><body><div id="root"></div></body></html>`;

function page(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function routed(url: string) {
  const host = new URL(url).host;
  if (host === 'api.freeappstore.online') return page('ok', 200, { 'content-type': 'text/plain' });
  if (url.endsWith('/registry.json')) {
    return new Response(
      JSON.stringify({
        apps: [
          { id: 'language', crossOriginIsolated: false },
          { id: 'math' },
          { id: 'wasm', crossOriginIsolated: true },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (host.startsWith('no-such-app-')) {
    return page(
      'Not Found: no app registered at no-such-app-issue-308.freeappstore.online.\n',
      404,
      {
        'content-type': 'text/plain; charset=utf-8',
      },
    );
  }
  if (url.endsWith('.js')) {
    return page('console.log(1)', 200, { 'content-type': 'application/javascript; charset=utf-8' });
  }
  const script = host.startsWith('wasm.')
    ? ''
    : '<script type="module" src="/assets/index-abc.js"></script>';
  const headers = host.startsWith('wasm.')
    ? {
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'credentialless',
      }
    : {};
  return page(html(script), 200, headers);
}

describe('app-host release check (#308)', () => {
  it('treats a worker exception as the production 1101 failure', () => {
    expect(workerFailure(500, '<html>Error 1101 Worker threw exception</html>')).toBe('HTTP 500');
    expect(workerFailure(200, 'Error 1101: Worker threw exception')).toBe('cloudflare 1101');
    expect(workerFailure(200, '<html>ok</html>')).toBeNull();
  });

  it('rejects COOP/COEP on a default response and accepts a normal root', () => {
    const headers = new Headers({
      'content-type': 'text/html',
      'cross-origin-opener-policy': 'same-origin',
    });
    expect(hasCrossOriginIsolation(headers)).toBe(true);
    expect(assessRoot(200, html(''), headers, false)).toBe('COOP/COEP set on a default app');
    expect(assessRoot(200, html(''), headers, true)).toBeNull();
    expect(
      assessRoot(200, html(''), new Headers({ 'content-type': 'text/html' }), false),
    ).toBeNull();
    expect(
      assessUnknownHost(404, 'Not Found: no app registered at missing.freeappstore.online.\n'),
    ).toBeNull();
    expect(assessUnknownHost(500, 'Error 1101')).toBe('HTTP 500');
    expect(
      assessAsset(200, 'x', new Headers({ 'content-type': 'application/javascript' }), false),
    ).toBeNull();
    expect(localScriptSrc(html('<script type="module" src="/assets/index-abc.js"></script>'))).toBe(
      '/assets/index-abc.js',
    );
    expect(
      localScriptSrc(
        html('<script type="module" crossorigin src="./assets/index-Clnup1Bp.js"></script>'),
      ),
    ).toBe('./assets/index-Clnup1Bp.js');
    expect(localScriptSrc(html('<script src="beacon.min.js"></script>'))).toBeNull();
    expect(localScriptSrc(html('<script src="./registerSW.js"></script>'))).toBeNull();
    expect(
      localScriptSrc(html('<script src="https://cdn.example/assets/index.js"></script>')),
    ).toBeNull();
  });

  it('passes a fleet whose roots, assets, console, and unknown host answer', async () => {
    const result = await verifyAppHost({
      fetch: async (url: string) => routed(String(url)),
      log: () => {},
      registryUrl: 'https://freeappstore.online/registry.json',
      healthUrl: 'https://api.freeappstore.online/health',
      consoleUrl: 'https://console.freeappstore.online/',
      unknownHostUrl: 'https://no-such-app-issue-308.freeappstore.online/',
    });
    expect(result.ok).toBe(true);
    expect(result.checkedRoots).toBe(3);
    expect(result.checkedAssets).toBe(2);
  });

  it('follows the console relative ./assets bundle to the console origin', async () => {
    const seen: string[] = [];
    const result = await verifyAppHost({
      fetch: async (url: string) => {
        const target = String(url);
        seen.push(target);
        if (target === 'https://console.freeappstore.online/') {
          return page(
            html('<script type="module" crossorigin src="./assets/index-Clnup1Bp.js"></script>'),
          );
        }
        return routed(target);
      },
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(seen).toContain('https://console.freeappstore.online/assets/index-Clnup1Bp.js');
  });

  it('fails when every hosted app is the unmigrated worker exception', async () => {
    const result = await verifyAppHost({
      fetch: async (url: string) => {
        const host = new URL(String(url)).host;
        if (host === 'api.freeappstore.online')
          return page('ok', 200, { 'content-type': 'text/plain' });
        if (String(url).endsWith('/registry.json')) return routed(String(url));
        if (host.startsWith('no-such-app-')) return routed(String(url));
        return page('<html>Error 1101 Worker threw exception</html>', 500);
      },
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((line) => line.includes('console'))).toBe(true);
    expect(result.failures.some((line) => line.includes('language'))).toBe(true);
    expect(result.failures.some((line) => line.startsWith('unknown host'))).toBe(false);
  });

  it('bursts run first, then apps spread across the registry (#643)', () => {
    const ids = ['a', 'b', 'c', 'run', 'd', 'e', 'f', 'g', 'h'];
    expect(burstTargets(ids, 4)).toEqual(['run', 'a', 'c', 'f']);
    expect(burstTargets(['a', 'b'], 6)).toEqual(['a', 'b']);
    expect(burstTargets([], 6)).toEqual([]);
  });

  it('sends each burst concurrently and fails on any 5xx in it (#643)', async () => {
    let open = 0;
    let peak = 0;
    let n = 0;
    const failures = await burstApps(['run'], {
      requests: 8,
      fetch: async () => {
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((r) => setTimeout(r, 5));
        open -= 1;
        n += 1;
        return n % 4 === 0 ? page('error code: 1101', 500) : page(html(''));
      },
    });
    expect(peak).toBe(8);
    expect(failures).toEqual(['burst run https://run.freeappstore.online/: 2/8 failed: HTTP 500']);
  });

  it('fails the release when only overlapping requests crash, as in #639', async () => {
    // A single request per root passes; the second of two in flight throws 1101.
    let inFlight = 0;
    const result = await verifyAppHost({
      fetch: async (url: string) => {
        const target = String(url);
        if (!/^https:\/\/(language|math)\./.test(target)) return routed(target);
        inFlight += 1;
        const crashed = inFlight > 1;
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return crashed ? page('error code: 1101', 500) : routed(target);
      },
      concurrency: 1,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.burstedApps).toEqual(['language', 'math', 'wasm']);
    expect(result.failures.every((line) => line.startsWith('burst '))).toBe(true);
    expect(result.failures.some((line) => line.startsWith('burst language'))).toBe(true);
  });
});
