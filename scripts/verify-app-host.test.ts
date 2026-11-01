import { describe, expect, it } from 'vitest';
import {
  assessAsset,
  assessRoot,
  assessUnknownHost,
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
});
