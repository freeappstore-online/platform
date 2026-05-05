#!/usr/bin/env node
// End-to-end smoke test against `wrangler dev`.
//
// Mints a session token with a known signing key (matches .dev.vars) and
// exercises every authenticated route. Run with:
//   pnpm dev:backend       # in one shell
//   node scripts/e2e-local.mjs
//
// Catches bugs that unit tests can't: real D1 type round-tripping,
// WebSocket upgrade flow through the Worker → Durable Object boundary,
// and quota math against actual stored bytes.

import { setTimeout as sleep } from 'node:timers/promises';

const API = process.env.API ?? 'http://localhost:8787';
const KEY =
  process.env.SESSION_SIGNING_KEY ??
  'local_test_key_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const APP_ID = 'e2e';

let passed = 0;
let failed = 0;

function pass(label) {
  passed++;
  console.log(`  ✅ ${label}`);
}
function fail(label, detail) {
  failed++;
  console.log(`  ❌ ${label}\n     ${detail}`);
}
function assert(cond, label, detail = '') {
  cond ? pass(label) : fail(label, detail);
}

function b64url(s) {
  return Buffer.from(s).toString('base64url');
}

async function hmac(data, key) {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return Buffer.from(sig).toString('base64url');
}

async function mintSession(uid) {
  const payload = {
    uid,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmac(body, KEY);
  return `${body}.${sig}`;
}

async function req(path, init = {}, token) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API}${path}`, { ...init, headers });
}

async function main() {
  console.log(`\n=== e2e against ${API} ===\n`);

  // health
  let res = await fetch(`${API}/health`);
  assert(res.status === 200, '/health returns 200');

  // unauthenticated probes
  res = await fetch(`${API}/v1/auth/me`);
  assert(res.status === 401, '/v1/auth/me without token returns 401');

  res = await fetch(`${API}/v1/apps/${APP_ID}/kv/x`);
  assert(res.status === 401, 'KV read without token returns 401');

  // mint a valid session (the test user gh:1 was inserted into local D1)
  const token = await mintSession('gh:1');

  res = await req('/v1/auth/me', {}, token);
  assert(res.status === 200, '/v1/auth/me with valid token returns 200');
  const me = res.status === 200 ? await res.json() : null;
  assert(me?.login === 'testuser', '/v1/auth/me returns the right user', JSON.stringify(me));

  // KV happy path
  res = await req(
    `/v1/apps/${APP_ID}/kv/foo`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    },
    token,
  );
  assert(res.status === 204, 'KV PUT returns 204');

  res = await req(`/v1/apps/${APP_ID}/kv/foo`, {}, token);
  const got = res.status === 200 ? await res.json() : null;
  assert(res.status === 200 && got?.hello === 'world', 'KV GET returns the value we set', JSON.stringify(got));

  // KV overwrite
  res = await req(
    `/v1/apps/${APP_ID}/kv/foo`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'mars' }),
    },
    token,
  );
  assert(res.status === 204, 'KV overwrite returns 204');
  res = await req(`/v1/apps/${APP_ID}/kv/foo`, {}, token);
  const got2 = res.status === 200 ? await res.json() : null;
  assert(got2?.hello === 'mars', 'KV GET returns overwritten value');

  // KV empty body 400
  res = await req(`/v1/apps/${APP_ID}/kv/empty`, { method: 'PUT', body: '' }, token);
  assert(res.status === 400, 'KV PUT with empty body returns 400');

  // KV oversize 413
  const big = JSON.stringify({ x: 'a'.repeat(70 * 1024) });
  res = await req(
    `/v1/apps/${APP_ID}/kv/big`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: big },
    token,
  );
  assert(res.status === 413, 'KV PUT oversize returns 413');

  // KV missing key
  res = await req(`/v1/apps/${APP_ID}/kv/nonexistent`, {}, token);
  assert(res.status === 404, 'KV GET missing key returns 404');

  // KV delete + verify
  res = await req(`/v1/apps/${APP_ID}/kv/foo`, { method: 'DELETE' }, token);
  assert(res.status === 204, 'KV DELETE returns 204');
  res = await req(`/v1/apps/${APP_ID}/kv/foo`, {}, token);
  assert(res.status === 404, 'KV GET after DELETE returns 404');

  // WebSocket — connect, send, receive
  console.log('\n--- WebSocket room round-trip ---');
  await testWebSocket(token);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

async function testWebSocket(token) {
  const wsUrl = `${API.replace(/^http/, 'ws')}/v1/apps/${APP_ID}/rooms/lobby?token=${encodeURIComponent(token)}`;

  const a = new WebSocket(wsUrl);
  const b = new WebSocket(wsUrl);

  const aMsgs = [];
  const bMsgs = [];
  a.addEventListener('message', (ev) => aMsgs.push(JSON.parse(ev.data)));
  b.addEventListener('message', (ev) => bMsgs.push(JSON.parse(ev.data)));

  await Promise.all([
    new Promise((r, j) => {
      a.addEventListener('open', r);
      a.addEventListener('error', j);
    }),
    new Promise((r, j) => {
      b.addEventListener('open', r);
      b.addEventListener('error', j);
    }),
  ]);
  pass('two WebSocket clients connected');

  // After both connect, both should have received a peers broadcast.
  await sleep(200);
  const aSawPeers = aMsgs.some((m) => m.kind === 'peers');
  const bSawPeers = bMsgs.some((m) => m.kind === 'peers');
  assert(aSawPeers && bSawPeers, 'both clients received a peers message');

  // a sends — b should receive (a should NOT, since broadcast skips sender)
  a.send(JSON.stringify({ kind: 'msg', data: { tag: 'from-a' } }));
  await sleep(200);

  const bGotMsg = bMsgs.find((m) => m.kind === 'msg' && m.data?.tag === 'from-a');
  assert(!!bGotMsg, "client b received a's message", `bMsgs=${JSON.stringify(bMsgs)}`);
  if (bGotMsg) {
    assert(
      typeof bGotMsg.from === 'object' && typeof bGotMsg.from.uid === 'string' && typeof bGotMsg.from.login === 'string',
      'msg.from is { uid, login }',
      `from=${JSON.stringify(bGotMsg.from)}`,
    );
  }

  const aGotOwnMsg = aMsgs.find(
    (m) => m.kind === 'msg' && m.data?.from === 'a' && !aMsgs.indexOf(m) === false,
  );
  // Sender should NOT receive their own broadcast (that's by design in room.ts).
  // We assert the count of msg-kind frames received by `a` is 0.
  const aMsgCount = aMsgs.filter((m) => m.kind === 'msg').length;
  assert(aMsgCount === 0, 'sender does not receive their own broadcast', `aMsgs=${JSON.stringify(aMsgs)}`);

  // Oversize message — should be dropped + warned (not crash the connection).
  const huge = 'x'.repeat(5000);
  a.send(JSON.stringify({ kind: 'msg', data: { huge } }));
  await sleep(200);
  const aGotError = aMsgs.find((m) => m.kind === 'error' && m.error === 'message_too_large');
  assert(!!aGotError, 'oversize message → "message_too_large" error to sender');

  a.close();
  b.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
