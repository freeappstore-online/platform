#!/usr/bin/env node
// Production e2e canary for the FreeAppStore *platform* (not the storefront,
// not individual apps). It exercises the real creator pipeline end-to-end:
//
//   exchange GitHub token -> fas session
//   POST api/v1/publish   -> admin provisions a repo from template-standalone,
//                            CF Pages + DNS + D1 route + storefront registry
//   verify                -> GitHub repo exists, host route answers, ownership row
//   POST api/v1/unpublish  -> admin deprovisions (registry + route + R2 + DNS +
//                            repo), the same owner path a creator would use
//   verify                -> host route gone, ownership gone, repo gone
//
// "Host route answers" is deliberately NOT "host serves the app". Provisioning
// creates an EMPTY repo on purpose (workers/admin/src/publish.ts, step 1): the
// creator's own `git push` is what triggers the template's deploy.yml and puts
// files in R2. This canary never pushes code, so a 200 can never happen here —
// the first 100 runs waited 10 minutes for one. What provisioning does promise
// is the D1 route: freeappstore-host answers a routed-but-empty slug with
// "has no asset at this path" and an unrouted one with "no app registered".
// The deploy path itself is covered by smoke-sandbox (see prod-smoke.yml).
//
// It also probes the cheap deterministic surfaces around that flow: service
// health, storefront + registry reads, and the auth gates (endpoints that must
// 401 without a session).
//
// This is the FAS counterpart to FGS's prod-create-canary.mjs. The key
// difference is auth: FAS uses stateless Bearer session tokens on the unified
// api.freeappstore.online (no per-store auth worker, no cookies), and cleanup
// goes through api/v1/unpublish -> ADMIN service binding, so it never has to
// reach the Cloudflare-Access-gated admin Worker directly.
//
// Required env (CI):
//   FAS_E2E_GITHUB_TOKEN  Canary creator token from GitHub's DEVICE FLOW against
//                         FAS's own OAuth app (read:user). /v1/auth/exchange
//                         introspects it with GitHub's app-authenticated
//                         check-token endpoint and 401s any token not issued to
//                         that client_id (#47) — a PAT will NOT work. See
//                         ops/SKILLS.md -> Provisioning FAS_E2E_GITHUB_TOKEN.
//
// Local use without a token — run only the non-destructive public/auth-gate
// checks against prod:
//   FAS_E2E_ALLOW_NO_TOKEN=1 node scripts/prod-platform-e2e.mjs

const API_BASE = (process.env.FAS_API_BASE || 'https://api.freeappstore.online').replace(
  /\/+$/,
  '',
);
const STORE_ORIGIN = (process.env.FAS_STORE_ORIGIN || 'https://freeappstore.online').replace(
  /\/+$/,
  '',
);
const GITHUB_ORG = process.env.FAS_GITHUB_ORG || 'freeappstore-online';
const APP_DOMAIN = process.env.FAS_APP_DOMAIN || 'freeappstore.online';
const RAW_GITHUB_TOKEN = (process.env.FAS_E2E_GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const EXISTING_APP_ID = process.env.FAS_E2E_EXISTING_APP_ID || 'mandarin-english';
const POLL_MS = Number(process.env.FAS_E2E_POLL_MS || 15_000);
const HOST_TIMEOUT_MS = Number(process.env.FAS_E2E_HOST_TIMEOUT_MS || 10 * 60_000);
const HOST_CLEANUP_TIMEOUT_MS = Number(process.env.FAS_E2E_HOST_CLEANUP_TIMEOUT_MS || 3 * 60_000);
const ALLOW_NO_TOKEN = process.env.FAS_E2E_ALLOW_NO_TOKEN === '1';

function fail(message) {
  throw new Error(message);
}

function assert(value, message) {
  if (!value) fail(message);
}

function canaryId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `e2e-canary-${stamp}${rand}`;
}

// A hard guard so this script can never create or tear down anything that
// isn't a clearly-marked canary — even if FAS_E2E_APP_ID is set by hand.
function assertSafeCanaryId(id) {
  if (!/^e2e-canary-[a-z0-9]{4,20}$/.test(id)) {
    fail(`unsafe canary id "${id}"; FAS_E2E_APP_ID must match e2e-canary-<alnum>`);
  }
}

async function fetchText(url, init = {}, timeoutMs = 60_000) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'fas-prod-platform-e2e', ...(init.headers || {}) },
  });
  const text = await res.text().catch(() => '');
  return { res, text };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} returned non-JSON: ${text.slice(0, 500)}`);
  }
}

async function expectStatus(label, url, init, expected, timeoutMs = 30_000) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  const { res, text } = await fetchText(url, init, timeoutMs);
  if (!allowed.includes(res.status)) {
    fail(
      `${label} expected HTTP ${allowed.join('/')} but got ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  console.log(`  ${label}: ${res.status}`);
  return { res, text };
}

async function expectJson(label, url, init, expected, timeoutMs = 30_000) {
  const { res, text } = await expectStatus(label, url, init, expected, timeoutMs);
  return { res, data: parseJson(text, label) };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ── Non-destructive surfaces (no session needed) ──

async function verifyPublicSurfaces(id) {
  console.log('› public + auth-gate surfaces');
  const health = await expectStatus('api /health', `${API_BASE}/health`, {}, 200);
  assert(/ok|healthy|"status"/i.test(health.text) || health.text.length >= 0, 'health had no body');

  const home = await expectStatus('storefront home', STORE_ORIGIN, {}, 200);
  assert(/FreeAppStore/i.test(home.text), 'storefront home did not render FreeAppStore text');

  // Public D1-backed creator feed (the source of truth for app ownership; the
  // storefront compiles its registry into HTML rather than serving a JSON file).
  const creators = await expectJson(
    'apps /v1/apps/creators',
    `${API_BASE}/v1/apps/creators`,
    {},
    200,
  );
  assert(
    creators.data.creators && typeof creators.data.creators === 'object',
    '/v1/apps/creators did not return a creators map',
  );
  assert(
    creators.data.creators[EXISTING_APP_ID],
    `/v1/apps/creators is missing the known app ${EXISTING_APP_ID}`,
  );

  // Auth gates: these MUST reject an unauthenticated caller.
  await expectStatus('auth /v1/auth/me unauthenticated', `${API_BASE}/v1/auth/me`, {}, 401);
  await expectStatus('apps /v1/apps/mine unauthenticated', `${API_BASE}/v1/apps/mine`, {}, 401);
  await expectStatus(
    'publish /v1/publish unauthenticated',
    `${API_BASE}/v1/publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: id }),
    },
    401,
  );
  await expectStatus(
    'unpublish /v1/unpublish unauthenticated',
    `${API_BASE}/v1/unpublish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    },
    401,
  );
}

// ── Auth + the create/verify/cleanup pipeline (needs a session) ──

async function exchangeToken(githubToken) {
  const { res, text } = await fetchText(
    `${API_BASE}/v1/auth/exchange`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ githubToken }),
    },
    30_000,
  );
  // Check the status BEFORE parsing. /v1/auth/exchange answers with plain text
  // on every failure path ('github token was not issued to this application',
  // 'token exchange is not configured', ...), so parsing first turned a clear
  // 401 into "returned non-JSON: github token was not issued…" — the real
  // message, wrapped in a parse error that implied the endpoint was broken.
  if (!res.ok) {
    fail(`token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = parseJson(text, '/v1/auth/exchange');
  if (!data.sessionToken) {
    fail(`token exchange returned no sessionToken (${res.status}): ${text.slice(0, 300)}`);
  }
  const login = data.user?.login || '?';
  console.log(`  exchanged GitHub token for fas session: @${login}`);
  return { token: data.sessionToken, login };
}

async function verifyAuthenticatedSurfaces(token) {
  const mine = await expectJson(
    'apps /v1/apps/mine authenticated',
    `${API_BASE}/v1/apps/mine`,
    { headers: bearer(token) },
    200,
  );
  assert(Array.isArray(mine.data.apps), '/v1/apps/mine did not return an apps array');
}

async function ownsApp(token, id) {
  const { data } = await expectJson(
    'apps /v1/apps/mine',
    `${API_BASE}/v1/apps/mine`,
    { headers: bearer(token) },
    200,
  );
  return Array.isArray(data.apps) && data.apps.some((a) => a?.id === id);
}

async function publishApp(id, token) {
  const payload = {
    name: id,
    store: 'apps',
    category: 'Utilities',
    type: 'standalone',
    oneliner: 'Automated production platform e2e canary — auto-removed at end of run.',
    description:
      'Automated production platform e2e canary created by prod-platform-e2e.mjs. ' +
      'It is provisioned, verified live, then unpublished within the same run.',
    repo: null,
    demo: null,
  };
  const { res, text } = await fetchText(
    `${API_BASE}/v1/publish`,
    { method: 'POST', headers: bearer(token), body: JSON.stringify(payload) },
    120_000,
  );
  const data = parseJson(text, '/v1/publish');
  if (!res.ok) {
    fail(
      `publish failed (${res.status}): ${data.error || text.slice(0, 500)} ${JSON.stringify(data.failedSteps || data.admin?.steps || '')}`,
    );
  }
  console.log(`  published ${id}: ${data.appUrl}`);
  return data;
}

async function unpublishApp(id, token) {
  const { res, text } = await fetchText(
    `${API_BASE}/v1/unpublish`,
    {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ id, store: 'apps', deleteRepo: true }),
    },
    120_000,
  );
  if (res.status === 404) {
    console.warn(`  cleanup: ${id} already gone (404)`);
    return;
  }
  const data = parseJson(text, '/v1/unpublish');
  if (!res.ok || data.admin?.ok === false) {
    // A cleanup that leaves anything behind is a failed run, not a warning:
    // every scheduled run would leak another repo/registry card/D1 row, and a
    // green badge over that is exactly the "untested reported as healthy"
    // trap prod-smoke fell into. Name the failed admin steps so the fix is
    // obvious from the issue comment.
    const failed = (data.admin?.steps || [])
      .filter((s) => s.status === 'fail')
      .map((s) => `${s.name}: ${s.detail}`)
      .join('; ');
    fail(
      `unpublish returned ${res.status}: ${data.error || text.slice(0, 200)}${failed ? ` — failed steps: ${failed}` : ''}`,
    );
  }
  console.log(`  unpublished ${id}: registry + route + R2 + DNS + repo removed`);
}

async function githubRepo(id) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'fas-prod-platform-e2e' };
  if (RAW_GITHUB_TOKEN) headers.Authorization = `Bearer ${RAW_GITHUB_TOKEN}`;
  return await fetchText(
    `https://api.github.com/repos/${GITHUB_ORG}/${encodeURIComponent(id)}`,
    { headers },
    30_000,
  );
}

async function verifyRepoExists(id) {
  const { res, text } = await githubRepo(id);
  if (res.status !== 200)
    fail(
      `expected GitHub repo ${GITHUB_ORG}/${id} to exist, got ${res.status}: ${text.slice(0, 200)}`,
    );
  const data = parseJson(text, 'github repo');
  assert(data.name === id, `github repo returned wrong name: ${data.name}`);
  assert(data.private === false, `canary repo ${id} is private; app repos must be public (MIT)`);
  console.log(`  github repo live: ${GITHUB_ORG}/${id}`);
}

async function verifyRepoGone(id) {
  const deadline = Date.now() + HOST_CLEANUP_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const { res } = await githubRepo(id);
    if (res.status === 404) {
      console.log(`  github repo removed: ${GITHUB_ORG}/${id}`);
      return;
    }
    last = String(res.status);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  fail(`github repo ${GITHUB_ORG}/${id} still present after unpublish (last ${last})`);
}

// freeappstore-host answers every unknown path with 404, so the body is the
// signal: "no app registered" = no D1 route, "has no asset" = routed but R2 is
// empty (the state provisioning leaves a repo in), 2xx = deployed.
async function waitForRoute(id, wantRouted) {
  const url = `https://${id}.${APP_DOMAIN}/`;
  const deadline = Date.now() + (wantRouted ? HOST_TIMEOUT_MS : HOST_CLEANUP_TIMEOUT_MS);
  let last = 'not checked';
  while (Date.now() < deadline) {
    try {
      const { res, text } = await fetchText(url, { method: 'GET' }, 30_000);
      const routed = res.ok || (res.status === 404 && /has no asset/i.test(text));
      last = `${res.status} ${text.slice(0, 60).replace(/\s+/g, ' ')}`;
      if (routed === wantRouted) {
        console.log(`  host route ${wantRouted ? 'answers' : 'gone'}: ${url} -> ${last}`);
        return;
      }
    } catch (e) {
      if (!wantRouted) {
        console.log(`  host route gone: ${url} -> ${e.message}`);
        return;
      }
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  fail(`host route did not become ${wantRouted ? 'routed' : 'unrouted'} in time: ${url} last=${last}`);
}

async function main() {
  const id = process.env.FAS_E2E_APP_ID || canaryId();
  assertSafeCanaryId(id);
  console.log(`FAS prod platform e2e — canary id: ${id}\n`);

  await verifyPublicSurfaces(id);

  if (!RAW_GITHUB_TOKEN) {
    if (ALLOW_NO_TOKEN) {
      console.log(
        '\nFAS_E2E_GITHUB_TOKEN not set — ran public/auth-gate checks only (FAS_E2E_ALLOW_NO_TOKEN=1).',
      );
      return;
    }
    fail(
      'FAS_E2E_GITHUB_TOKEN is required. It must be a device-flow token for FAS\'s OAuth app, not a PAT — see ops/SKILLS.md -> Provisioning FAS_E2E_GITHUB_TOKEN.',
    );
  }

  console.log('\n› authenticated pipeline');
  const { token } = await exchangeToken(RAW_GITHUB_TOKEN);
  await verifyAuthenticatedSurfaces(token);

  let created = false;
  let primary = null;
  try {
    await publishApp(id, token);
    created = true;
    await verifyRepoExists(id);
    assert(await ownsApp(token, id), `${id} did not appear in /v1/apps/mine after publish`);
    await waitForRoute(id, true);
    console.log('  ✓ create path verified');
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    if (created) {
      console.log('\n› cleanup');
      try {
        await unpublishApp(id, token);
        await waitForRoute(id, false);
        await verifyRepoGone(id);
        assert(!(await ownsApp(token, id)), `${id} still present in /v1/apps/mine after unpublish`);
        console.log('  ✓ cleanup verified');
      } catch (cleanupErr) {
        // A throw here would replace the create-path failure with the cleanup
        // one and hide what actually broke (which is what happened for the
        // host-live timeout). Report it; let the primary error win.
        if (primary) console.error(`  cleanup also failed: ${cleanupErr.message}`);
        else throw cleanupErr;
      }
    }
  }

  console.log('\nprod platform e2e passed.');
}

main().catch((e) => {
  console.error(`\nprod platform e2e FAILED: ${e?.message || e}`);
  process.exit(1);
});
