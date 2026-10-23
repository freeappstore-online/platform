import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../functions/apps/[[path]].js', import.meta.url), 'utf8');
const registry = { apps: [{ id: 'live' }, { id: 'unbuilt', status: 'unavailable' }, { id: 'draft', status: 'pending' }, { id: 'awaiting-deploy', discoveryStatus: 'pending' }, { id: 'private', private: true }, { id: 'new-live', discoveryStatus: 'live' }] };
const prepared = source.replace("import registry from '../../registry.json';", `const registry = ${JSON.stringify(registry)};`).replace("'../../lib/discovery.cjs'", JSON.stringify(new URL('../lib/discovery.cjs', import.meta.url).href));
const { onRequest } = await import(`data:text/javascript,${encodeURIComponent(prepared)}`);

test('withdrawn, draft, deleted and legacy listings cannot return cached public HTML', async () => {
  for (const id of ['unbuilt', 'draft', 'deleted', 'unbuilt.html', 'awaiting-deploy', 'awaiting-deploy.html', 'private']) {
    const response = await onRequest({ request: new Request(`https://freeappstore.online/apps/${id}`), next() { throw new Error('Must not reach cached asset'); } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  }
});

test('eligible clean and legacy detail URLs preserve normal Pages behavior; HEAD has no body', async () => {
  for (const id of ['live', 'live.html', 'live/', 'new-live']) {
    const response = await onRequest({ request: new Request(`https://freeappstore.online/apps/${id}`), next: async () => new Response('Published listing') });
    assert.equal(await response.text(), 'Published listing');
  }
  const head = await onRequest({ request: new Request('https://freeappstore.online/apps/unbuilt', { method: 'HEAD' }) });
  assert.equal(head.status, 404);
  assert.equal(await head.text(), '');
});
