/**
 * Proxy /app/* to the FAS console (console.freeappstore.online).
 * Same pattern as PAS — single origin, shared auth, PWA scoped to /app/.
 *
 * The console (platform/sites/console) MUST be built with a relative Vite base
 * ('./'). This proxy strips the /app prefix before fetching the origin, so the
 * console's asset URLs have to resolve relative to /app/ in the browser. With
 * an absolute base ('/') the browser requests /assets/* at the apex root, which
 * never reaches this function and 404s. See sites/console/CLAUDE.md.
 */

const CONSOLE_ORIGIN = 'https://console.freeappstore.online';

export const onRequest: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);

  // Redirect /app (no trailing slash) to /app/ so relative paths resolve correctly.
  if (url.pathname === '/app') {
    return Response.redirect(`${url.origin}/app/${url.search}${url.hash}`, 301);
  }

  const path = url.pathname.replace(/^\/app/, '') || '/';
  const isAsset = /\.(js|css|json|png|svg|ico|woff2|webp|webmanifest|map|txt)$/.test(path);
  const target = `${CONSOLE_ORIGIN}${path}${url.search}`;

  const res = await fetch(target, {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
  });

  // Static assets: return 404, don't serve HTML as JS/CSS
  if (res.status === 404 && isAsset) {
    return new Response('Not Found', { status: 404 });
  }

  // SPA fallback: non-asset 404s serve index.html
  if (res.status === 404) {
    const fallback = await fetch(`${CONSOLE_ORIGIN}/index.html`);
    return new Response(fallback.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  }

  const headers = new Headers(res.headers);
  if (/\.[0-9a-f]{8,}\.(js|css)$/.test(path) || /\.(woff2|png|svg|ico)$/.test(path)) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (path.endsWith('.html') || path === '/') {
    headers.set('Cache-Control', 'no-cache');
  }

  return new Response(res.body, { status: res.status, headers });
};
