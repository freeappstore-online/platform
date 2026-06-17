/**
 * freeappstore-kb-host — serves every project's Knowledge Base site from ONE R2
 * bucket at kb.freeappstore.online/<app>/…  (Path B: one Worker + one bucket, no
 * CF Pages project per KB). CI builds each KB to a Zensical static site and
 * uploads it to R2 under "<app>/*"; this Worker maps the request path to that
 * key. Official platform docs use the same generated site under the "platform"
 * prefix, exposed publicly at docs.freeappstore.online/.
 *
 *   GET kb.freeappstore.online/myapp/            → R2  myapp/index.html
 *   GET kb.freeappstore.online/myapp/setup/      → R2  myapp/setup/index.html
 *   GET kb.freeappstore.online/myapp/assets/x.css→ R2  myapp/assets/x.css
 *   GET docs.freeappstore.online/ui/             → R2  platform/ui/index.html
 *
 * Dedicated subdomain, NOT a wildcard route — so it can't preempt sibling Worker
 * custom_domains on the zone.
 */

export interface Env {
  KB_R2: R2Bucket;
  /** Dedicated KB-ingest token (Doppler KB_INGEST_TOKEN), synced by CI — auth
   *  for the docs-publish CI job. Separate from the provisioning token so a
   *  docs-pipeline leak can't reach the backend↔admin plane. */
  KB_INGEST_TOKEN: string;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  eot: 'application/vnd.ms-fontobject',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

function contentType(key: string): string {
  const ext = key.includes('.') ? key.split('.').pop()!.toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

const DOCS_HOSTS = new Set(['docs.freeappstore.online']);

function isDocsHost(hostname: string): boolean {
  return DOCS_HOSTS.has(hostname.toLowerCase());
}

/** Map a request path to an R2 key. Directory / extensionless paths -> index.html. */
export function keyForPath(pathname: string, hostname = 'kb.freeappstore.online'): string | null {
  let key = decodeURIComponent(pathname.replace(/^\/+/, ''));
  if (isDocsHost(hostname)) key = key ? `platform/${key}` : 'platform/';
  if (key === '') return null; // bare KB host — no KB selected
  if (key.includes('..')) return null; // path traversal guard
  if (key.endsWith('/')) key += 'index.html';
  else if (!key.split('/').pop()!.includes('.')) key += '/index.html'; // pretty URL -> dir index
  return key;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'freeappstore-kb-host', version: '0.1.0' });
    }

    // ── Ingest: CI uploads each built KB file here, written to R2 via the
    //    binding (no R2 API token needed → no token-scope 403). Authed by the
    //    dedicated KB_INGEST_TOKEN. PUT /_ingest/<app>/<path> with the file as body.
    if (request.method === 'PUT' && url.pathname.startsWith('/_ingest/')) {
      if (!env.KB_INGEST_TOKEN || request.headers.get('x-internal-token') !== env.KB_INGEST_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const key = decodeURIComponent(url.pathname.slice('/_ingest/'.length));
      if (!key || key.includes('..') || key.endsWith('/'))
        return new Response('bad key', { status: 400 });
      await env.KB_R2.put(key, request.body);
      return new Response('ok\n');
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    if (
      isDocsHost(url.hostname) &&
      (url.pathname === '/platform' || url.pathname.startsWith('/platform/'))
    ) {
      url.pathname = url.pathname.replace(/^\/platform/, '') || '/';
      return Response.redirect(url.toString(), 301);
    }

    const key = keyForPath(url.pathname, url.hostname);
    if (key === null) {
      return new Response(
        'FreeAppStore Knowledge Base host - visit kb.freeappstore.online/<app>/ or docs.freeappstore.online',
        { status: 404 },
      );
    }

    const obj = await env.KB_R2.get(key);
    if (!obj) {
      const app = key.split('/')[0];
      const custom404 = app ? await env.KB_R2.get(`${app}/404.html`) : null;
      if (custom404) {
        return new Response(custom404.body, {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('Not found', { status: 404 });
    }

    const etag = obj.httpEtag;
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const headers = new Headers();
    headers.set('content-type', contentType(key));
    headers.set('etag', etag);
    headers.set(
      'cache-control',
      key.endsWith('.html') ? 'public, max-age=60, must-revalidate' : 'public, max-age=86400',
    );
    headers.set('x-content-type-options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
  },
};
