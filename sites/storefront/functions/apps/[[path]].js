import registry from '../../registry.json';
import discovery from '../../lib/discovery.cjs';

// A removed static asset can remain in an edge cache. Check public eligibility
// before Pages serves it, including legacy .html URLs. No customer data is read.
const published = new Set(registry.apps.filter(discovery.isPublicListing).map(app => app.id));

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  const match = /^\/apps\/([^/]+)\/?$/.exec(path);
  const id = match?.[1].replace(/\.html$/, '');
  if (!id || !published.has(id)) {
    return new Response(context.request.method === 'HEAD' ? null : 'App listing not found.\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  return context.next();
}
