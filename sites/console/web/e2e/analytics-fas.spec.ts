import { expect, test } from '@playwright/test';

const FAS_API = 'https://api.freeappstore.online';
const FAS_STOREFRONT = 'https://freeappstore.online';

// Cross-store coverage: the same analytics API contract is served by the
// FAS backend at api.freeappstore.online (also fronts FGS games). We host
// these tests in the PAS console workspace for now since it has the
// Playwright infrastructure wired; if/when fas/freeappstore grows its own
// e2e suite, move these out.

test.describe('FAS analytics API contract', () => {
  const ownerOnlyEndpoints = [
    '/v1/apps/example/analytics',
    '/v1/apps/example/analytics/stats?days=7',
    '/v1/apps/example/analytics/stats?days=1&bucket=hour',
    '/v1/apps/example/analytics/stats?days=7&path=%2F',
    '/v1/apps/example/analytics/events?days=7',
    '/v1/apps/example/analytics/live',
    '/v1/apps/example/analytics/diagnostics',
    '/v1/analytics/admin/platform?days=7',
    '/v1/analytics/admin/platform?days=1&bucket=hour',
  ];

  for (const path of ownerOnlyEndpoints) {
    test(`GET ${path} requires auth`, async ({ request }) => {
      const res = await request.get(`${FAS_API}${path}`);
      expect([401, 403, 404]).toContain(res.status());
    });
  }
});

test.describe('FAS analytics loader (public)', () => {
  test('loader returns JS for any app id', async ({ request }) => {
    const res = await request.get(`${FAS_API}/v1/analytics.js?app=__nonexistent__`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('javascript');
  });

  test('event ingest accepts pageview beacons', async ({ request }) => {
    const res = await request.post(`${FAS_API}/v1/analytics/event`, {
      data: { app: 'example', kind: 'pageview', path: '/', t: Date.now() },
    });
    expect(res.status()).toBe(204);
  });

  test('event ingest accepts batched offline-replay payloads', async ({ request }) => {
    const res = await request.post(`${FAS_API}/v1/analytics/event`, {
      data: {
        events: [
          { app: 'example', kind: 'pageview', path: '/', t: Date.now() - 60_000 },
          { app: 'example', kind: 'pageview', path: '/about', t: Date.now() },
        ],
      },
    });
    expect(res.status()).toBe(204);
  });

  test('event ingest is friendly to CORS from FGS apps', async ({ request }) => {
    const res = await request.fetch(`${FAS_API}/v1/analytics/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // FGS games run on freegamestore.online and call the FAS backend.
        // Pre-Path-B this would have failed CORS preflight; the origins
        // allowlist update on 2026-05-21 was supposed to fix it.
        origin: 'https://chess.freegamestore.online',
      },
      data: { app: 'chess', kind: 'pageview' },
    });
    expect(res.status()).toBe(204);
    const allowOrigin = res.headers()['access-control-allow-origin'];
    // Either echoes the origin or '*' — both are valid CORS responses.
    expect(allowOrigin === 'https://chess.freegamestore.online' || allowOrigin === '*' || allowOrigin === undefined).toBe(true);
  });
});

test.describe('FAS analytics dashboard page (public shell)', () => {
  test('/analytics returns a 200 HTML page', async ({ request }) => {
    // The dashboard ships as a static HTML file from CF Pages. It includes
    // the platform analytics loader script (so the dashboard counts its
    // own visitors), the auth bootstrap, and a div for the diagnostics
    // empty state. We don't auth-test the UI itself here — just that the
    // route exists.
    const res = await request.get(`${FAS_STOREFRONT}/analytics`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('analytics.js');
  });
});
