import registry from '../../registry.json';
import discovery from '../../lib/discovery.cjs';

const creators = new Set(registry.apps.filter(discovery.isPublicListing).map(app => app.creatorGithub).filter(Boolean));

// Retired or fixture-only creator assets must not reappear from an edge cache.
export async function onRequest(context) {
  const match = /^\/u\/([^/]+)\/?$/.exec(new URL(context.request.url).pathname);
  const creator = match?.[1].replace(/\.html$/, '');
  if (!creator || !creators.has(creator)) {
    return new Response(context.request.method === 'HEAD' ? null : 'Creator not found.\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  return context.next();
}
