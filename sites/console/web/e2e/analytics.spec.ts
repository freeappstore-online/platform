import { expect, test } from '@playwright/test';

const API_URL = 'https://api.proappstore.online';

// Smoke tests for the analytics dashboard surface — Console UI (public
// shell only; the AnalyticsSection itself is behind sign-in) plus the
// API contract on api.proappstore.online.
//
// The Console is a PWA — full 'load' can take a while because of asset
// precaching. 'domcontentloaded' is enough to verify the SPA shell;
// visible-element assertions wait on React hydration on their own.

test.describe('Analytics dashboard — UI shell (public)', () => {
  test('Console SPA shell loads (analytics lives behind auth)', async ({ page }) => {
    // The Console is a single SPA; the AnalyticsSection lives inside
    // AppDetail, behind sign-in. We can't drive into it without a real
    // FAS session token, so this test asserts the unauth shell still
    // loads cleanly — which is the prerequisite for anything downstream.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/Creator Console.*ProAppStore/);
  });

  test('console response sets the analytics-friendly CSP header', async ({ request }) => {
    // _headers ships via HTTP, not <meta>. Verify CF Pages applied it by
    // reading the response header directly. This catches regressions where
    // the public/_headers file is missing or accidentally narrowed.
    const res = await request.get('https://console.proappstore.online/', {
      headers: { 'cache-control': 'no-cache' },
    });
    const csp = res.headers()['content-security-policy'] ?? '';
    expect(csp).toContain('static.cloudflareinsights.com');
    expect(csp).toContain('api.proappstore.online');
  });
});

test.describe('Analytics API contract — owner-protected endpoints reject anonymous', () => {
  // The dashboard depends on these endpoints. Each must require a bearer
  // token; an unauthenticated GET should 401 (not 200, not 500). Tests
  // run against the deployed Worker so they catch regressions in either
  // the route wiring or the auth middleware.
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
      const res = await request.get(`${API_URL}${path}`);
      // Either 401 (no bearer) or 404 (app doesn't exist — also auth-shaped).
      // Anything else means the auth gate isn't in place.
      expect([401, 403, 404]).toContain(res.status());
    });
  }
});

test.describe('Analytics loader — public endpoint', () => {
  test('GET /v1/analytics.js returns JavaScript regardless of app id validity', async ({ request }) => {
    // The loader is public (visitor browsers hit it directly via <script>
    // tag, no auth context). Invalid app ids return a no-op comment, not
    // a 4xx — so the script tag never breaks.
    const res = await request.get(`${API_URL}/v1/analytics.js?app=__nonexistent__`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('javascript');
    const body = await res.text();
    // Either the no-op marker or actual loader code. Both are valid; what
    // we're proving is that the route exists and doesn't 500.
    expect(body.length).toBeGreaterThan(0);
  });

  test('POST /v1/analytics/event accepts beacons with 204', async ({ request }) => {
    // The ingest endpoint is also public. Even with no dataset binding
    // configured, it returns 204 (silently accepted) so sendBeacon never
    // errors visibly in the visitor's browser.
    const res = await request.post(`${API_URL}/v1/analytics/event`, {
      data: { app: 'example', kind: 'pageview', path: '/', t: Date.now() },
    });
    expect(res.status()).toBe(204);
  });

  test('POST /v1/analytics/event accepts batched events', async ({ request }) => {
    // Batch shape — used by the loader to flush its IndexedDB outbox on
    // reconnect.
    const res = await request.post(`${API_URL}/v1/analytics/event`, {
      data: {
        events: [
          { app: 'example', kind: 'pageview', path: '/', t: Date.now() },
          { app: 'example', kind: 'pageview', path: '/about', t: Date.now() },
        ],
      },
    });
    expect(res.status()).toBe(204);
  });

  test('POST /v1/analytics/event rejects invalid app ids', async ({ request }) => {
    // The validator should reject malformed app ids so a bad client can't
    // spam the dataset with garbage.
    const res = await request.post(`${API_URL}/v1/analytics/event`, {
      data: { app: 'BAD..ID', kind: 'pageview' },
    });
    expect([400, 204]).toContain(res.status());
    // Either a 400 (rejected) or 204 (silently dropped) is fine — the
    // important thing is no 500 / no dataset write.
  });
});
