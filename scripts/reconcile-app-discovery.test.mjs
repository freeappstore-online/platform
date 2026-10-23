import assert from 'node:assert/strict';
import { test } from 'node:test';
import discovery from '../sites/storefront/lib/discovery.cjs';
import {
  githubClient,
  healthyIndexableLaunch,
  reconcileDiscovery,
} from './reconcile-app-discovery.mjs';

const app = (extra = {}) => ({
  id: 'example',
  name: 'Example',
  repo: 'freeappstore-online/example',
  appUrl: 'https://example.freeappstore.online/',
  discoveryStatus: 'pending',
  discoveryRequestedAt: '2026-10-24T00:00:00Z',
  ...extra,
});
const run = (extra = {}) => ({
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/deploy.yml',
  name: 'Deploy to R2',
  head_sha: 'deployed',
  status: 'completed',
  conclusion: 'success',
  ...extra,
});
const html = (content = '<html><head><title>Example</title></head><body>App</body></html>') =>
  new Response(content, { headers: { 'Content-Type': 'text/html' } });

function environment({
  apps = [app()],
  runs = [run()],
  head = 'deployed',
  beforeRead,
  conflict = false,
  dispatchFails = 0,
} = {}) {
  let registry = { apps: structuredClone(apps) };
  let reads = 0;
  let sha = 1;
  const calls = [];
  const github = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path.includes('/contents/')) {
      if (method === 'GET') {
        reads++;
        if (beforeRead) registry = beforeRead(reads, structuredClone(registry));
        return {
          sha: String(sha),
          content: Buffer.from(JSON.stringify(registry)).toString('base64'),
        };
      }
      assert.equal(body.sha, String(sha));
      assert.equal(body.branch, 'main');
      if (conflict) {
        conflict = false;
        sha++;
        return { conflict: true };
      }
      registry = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      sha++;
      return { content: { sha: String(sha) } };
    }
    if (path.includes('/actions/runs?')) return { workflow_runs: runs };
    if (path.endsWith('/commits/main')) return { sha: head };
    if (path.endsWith('/dispatches')) {
      assert.match(path, /\/workflows\/deploy-storefront.yml\/dispatches$/);
      assert.deepEqual(body, { ref: 'main' });
      if (dispatchFails-- > 0) throw new Error('Transient Actions failure');
      return {};
    }
    throw new Error(`Unexpected GitHub path ${path}`);
  };
  return { github, calls, registry: () => registry };
}

test('a provisioned empty repo or a failed/queued latest deploy remains pending despite old success', async () => {
  for (const runs of [
    [],
    [run({ conclusion: 'failure' }), run()],
    [run({ status: 'in_progress', conclusion: null }), run()],
  ]) {
    const env = environment({ runs });
    const result = await reconcileDiscovery(env.github, () => {
      throw new Error('Must not probe without a successful current deploy');
    });
    assert.deepEqual(result.promoted, []);
    assert.equal(env.registry().apps[0].discoveryStatus, 'pending');
  }
});

test('an arbitrary CI pass, PR, preview deployment or old commit cannot publish a listing', async () => {
  for (const options of [
    { runs: [run({ name: 'CI', path: '.github/workflows/test.yml' })] },
    { runs: [run({ event: 'pull_request' })] },
    { runs: [run({ name: 'Deploy preview' })] },
    { head: 'new-code-not-deployed' },
  ]) {
    const env = environment(options);
    const result = await reconcileDiscovery(env.github, () => {
      throw new Error('Must not probe an ineligible run');
    });
    assert.deepEqual(result.promoted, []);
  }
});

test('a successful retry plus healthy HTML promotes once and explicitly requests the existing storefront deploy', async () => {
  const env = environment();
  assert.deepEqual((await reconcileDiscovery(env.github, async () => html())).promoted, [
    'example',
  ]);
  assert.equal(env.registry().apps[0].discoveryStatus, 'live');
  assert.equal(env.registry().apps[0].discoveryDeliveryPending, undefined);
  const writes = env.calls.filter((call) => call.method === 'PUT').length;
  const again = await reconcileDiscovery(env.github, () => {
    throw new Error('Do not probe already-public apps');
  });
  assert.deepEqual(again.promoted, []);
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, writes);
  assert.equal(env.calls.filter((call) => call.path.endsWith('/dispatches')).length, 1);
});

test('delivery recovers if Actions dispatch fails after the promotion commit', async () => {
  const env = environment({ dispatchFails: 1 });
  await assert.rejects(
    reconcileDiscovery(env.github, async () => html()),
    /Actions failure/,
  );
  assert.equal(env.registry().apps[0].discoveryStatus, 'live');
  assert.ok(env.registry().apps[0].discoveryDeliveryPending);
  await reconcileDiscovery(env.github, () => {
    throw new Error('Delivery recovery must not probe live apps');
  });
  assert.equal(env.registry().apps[0].discoveryDeliveryPending, undefined);
});

test('unpublish, explicit private/unavailable changes, changed target and a new provisioning generation win a CAS race', async () => {
  for (const change of [
    () => ({ apps: [] }),
    (r) => ({ apps: r.apps.map((a) => ({ ...a, status: 'unavailable' })) }),
    (r) => ({ apps: r.apps.map((a) => ({ ...a, private: true })) }),
    (r) => ({ apps: r.apps.map((a) => ({ ...a, visibility: 'private' })) }),
    (r) => ({
      apps: r.apps.map((a) => ({ ...a, appUrl: 'https://migrated.freeappstore.online/' })),
    }),
    (r) => ({ apps: r.apps.map((a) => ({ ...a, discoveryRequestedAt: 'new-generation' })) }),
  ]) {
    const env = environment({
      beforeRead: (n, registry) => (n === 2 ? change(registry) : registry),
    });
    assert.deepEqual((await reconcileDiscovery(env.github, async () => html())).promoted, []);
    assert.equal(env.calls.filter((call) => call.method === 'PUT').length, 0);
  }
});

test('a 409 is retried with a fresh registry SHA and preserves unrelated metadata', async () => {
  const env = environment({
    conflict: true,
    beforeRead: (n, registry) => ({ ...registry, note: n > 1 ? 'concurrent writer' : 'initial' }),
  });
  assert.deepEqual((await reconcileDiscovery(env.github, async () => html())).promoted, [
    'example',
  ]);
  assert.equal(env.registry().note, 'concurrent writer');
});

test('temporary outages do not delist legacy or live apps; failed initial health stays pending', async () => {
  for (const apps of [[app({ discoveryStatus: undefined })], [app({ discoveryStatus: 'live' })]]) {
    const env = environment({ apps });
    await reconcileDiscovery(env.github, () => {
      throw new Error('Do not probe live/legacy apps');
    });
    assert.deepEqual(env.registry().apps, apps);
  }
  const env = environment();
  assert.deepEqual(
    (await reconcileDiscovery(env.github, async () => new Response('Unavailable', { status: 503 })))
      .promoted,
    [],
  );
});

test('health uses the current migrated launch URL and requires no host-fallback metadata', async () => {
  const target = 'https://new-target.freeappstore.online/';
  const env = environment({ apps: [app({ appUrl: target })] });
  const urls = [];
  await reconcileDiscovery(env.github, async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, undefined);
    return html();
  });
  assert.deepEqual(urls, [target]);
  assert.equal(env.registry().apps[0].discoveryStatus, 'live');
});

test('explicit noindex/none or conflicting canonicals block promotion; matching canonical is allowed', async () => {
  for (const tag of [
    '<meta name="robots" content="noindex, follow">',
    "<meta content='none' name='googlebot'>",
    '<link rel="canonical" href="https://somewhere-else.example/">',
  ]) {
    assert.equal(
      await healthyIndexableLaunch(app().appUrl, async () =>
        html(`<html><head>${tag}</head><body>App</body></html>`),
      ),
      false,
    );
  }
  assert.equal(
    await healthyIndexableLaunch(
      app().appUrl,
      async () =>
        new Response('<html>App</html>', {
          headers: { 'Content-Type': 'text/html', 'X-Robots-Tag': 'googlebot: noindex' },
        }),
    ),
    false,
  );
  assert.equal(
    await healthyIndexableLaunch(app().appUrl, async () =>
      html(
        `<html><head><link rel="canonical" href="${app().appUrl}"></head><body>App</body></html>`,
      ),
    ),
    true,
  );
});

test('redirects never receive GitHub credentials and cannot escape platform HTTPS launch origins', async () => {
  const calls = [];
  assert.equal(
    await healthyIndexableLaunch(app().appUrl, async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    }),
    false,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  const github = githubClient('example-test-token', async () => {
    throw new Error('Must not transmit');
  });
  await assert.rejects(github('https://untrusted.example/'), /api.github.com/);
});

test('new discovery state gates only publication and preserves explicit privacy/retirement decisions', () => {
  assert.equal(discovery.isPublicListing(app()), false);
  assert.equal(discovery.isPublicListing(app({ discoveryStatus: undefined })), true);
  assert.equal(discovery.isPublicListing(app({ discoveryStatus: 'live' })), true);
  for (const extra of [
    { status: 'unavailable' },
    { status: 'unpublished' },
    { private: true },
    { visibility: 'private' },
  ]) {
    assert.equal(discovery.isPublicListing(app({ discoveryStatus: 'live', ...extra })), false);
    assert.equal(discovery.isPendingListing(app(extra)), false);
  }
});
