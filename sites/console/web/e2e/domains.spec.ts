import { expect, test } from '@playwright/test';

const API_URL = 'https://api.proappstore.online';

// Smoke tests for the custom-domain feature shipped on the PAS Console.
//
// Two layers:
//   1. UI: console.proappstore.online — the SPA itself. Unauthenticated
//      tests can only check the Landing page (the Domains UI is inside
//      AppDetail, reached after sign-in + clicking into an app).
//   2. API: api.proappstore.online — the backend the Console talks to.
//      These tests prove the deployed Worker enforces auth + validates
//      input before mutation; they don't require a session.

test.describe('Console SPA — public', () => {
  // The Console is a PWA — full 'load' can take a while because of asset
  // precaching. 'domcontentloaded' is enough to verify the SPA shell;
  // visible-element assertions then wait on React hydration on their own.
  test('renders the landing page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/Creator Console.*ProAppStore/);
  });

  test('shows Sign in with GitHub CTA when not authenticated', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Creator Console' })).toBeVisible();
    // The phrase appears both in the descriptive paragraph and on the
    // button; target the button so strict-mode matching has one result.
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  });
});

test.describe('PAS API: /v1/apps/:appId/domains — auth + validation', () => {
  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${API_URL}/v1/apps/meetup/domains`, {
      data: { domain: 'example.com' },
    });
    expect(res.status()).toBe(401);
  });

  test('GET without auth returns 401', async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/apps/meetup/domains`);
    expect(res.status()).toBe(401);
  });

  test('DELETE without auth returns 401', async ({ request }) => {
    const res = await request.delete(`${API_URL}/v1/apps/meetup/domains/example.com`);
    expect(res.status()).toBe(401);
  });

  test('verify without auth returns 401', async ({ request }) => {
    const res = await request.post(
      `${API_URL}/v1/apps/meetup/domains/example.com/verify`,
    );
    expect(res.status()).toBe(401);
  });

  test('CORS preflight from console origin is allowed', async ({ request }) => {
    const res = await request.fetch(`${API_URL}/v1/apps/meetup/domains`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://console.proappstore.online',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(res.status()).toBe(204);
    expect(res.headers()['access-control-allow-origin']).toBe(
      'https://console.proappstore.online',
    );
    expect(res.headers()['access-control-allow-methods']).toMatch(/POST/);
  });

  // Regression: previously the deployed Worker read `result.verification_status`
  // instead of `result.status` from CF Pages, so domains never flipped from
  // pending → active. We can't verify the field-name fix end-to-end without
  // a real session, but we CAN confirm the route exists (auth check fires
  // first) — proving the deploy made it to prod.
  test('route exists in prod (auth check, not 404)', async ({ request }) => {
    const res = await request.post(`${API_URL}/v1/apps/meetup/domains`, {
      data: { domain: 'example.com' },
    });
    expect(res.status(), 'expected 401, not 404 — proves the route is deployed').toBe(401);
  });
});

// These confirm the auth-first ordering: an unauthenticated caller should
// see 401 regardless of how malformed their input is, because the route's
// validation logic must NOT leak detail to anonymous callers.
test.describe('PAS API: auth-before-validation', () => {
  const badPayloads = [
    { name: 'empty body', body: {} },
    { name: 'numeric domain', body: { domain: 123 } },
    { name: 'platform-managed domain', body: { domain: 'evil.proappstore.online' } },
    { name: 'IP address', body: { domain: '203.0.113.7' } },
    { name: 'leading hyphen label', body: { domain: 'foo.-bar.com' } },
  ];

  for (const { name, body } of badPayloads) {
    test(`unauth + ${name} → 401 (not 400)`, async ({ request }) => {
      const res = await request.post(`${API_URL}/v1/apps/meetup/domains`, { data: body });
      expect(res.status()).toBe(401);
    });
  }

  test('unauth + bogus :domain URL param → 401 (not 400)', async ({ request }) => {
    const res = await request.post(
      `${API_URL}/v1/apps/meetup/domains/${encodeURIComponent('not a domain')}/verify`,
    );
    expect(res.status()).toBe(401);
  });
});
