import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { preflight, distribute, client } from './testflight.mjs';
const config = { appId: '1', groupId: 'group', bundleId: 'online.freeappstore.companion', version: '0.2.0', minimum: 10 };
function preflightMock({ bundle = config.bundleId, internal = true, groupApp = '1', testers = ['tester'], builds = ['11'] } = {}) {
  return async path => {
    if (path === '/v1/apps/1') return { data: { attributes: { bundleId: bundle } } };
    if (path.startsWith('/v1/betaGroups/group?')) return { data: { attributes: { isInternalGroup: internal }, relationships: { app: { data: { id: groupApp } } } } };
    if (path.includes('betaTesters')) return { data: testers.map(id => ({ id })) };
    if (path.startsWith('/v1/builds?')) return { data: builds.map(version => ({ attributes: { version } })) };
    throw new Error(path);
  };
}
test('preflight validates app/group/testers and chooses a higher build', async () => {
  assert.deepEqual(await preflight(preflightMock(), config), { build: 12, testerCount: 1 });
  for (const bad of [{ bundle: 'another.app' }, { internal: false }, { groupApp: '2' }, { testers: [] }, { builds: ['1.2'] }]) {
    await assert.rejects(preflight(preflightMock(bad), config));
  }
});
test('processing success alone is insufficient; group assignment and beta eligibility are verified', async () => {
  let assigned = false; const calls = [];
  const request = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path.startsWith('/v1/builds?')) return { data: [{ id: 'build', attributes: { processingState: 'VALID', expired: false } }] };
    if (path.endsWith('/relationships/builds')) { assigned = true; return {}; }
    if (path === '/v1/betaGroups?filter[app]=1&filter[builds]=build&filter[id]=group&limit=200') return { data: assigned ? [{ id: 'group' }] : [] };
    if (path.endsWith('/buildBetaDetail')) return { data: { attributes: { internalBuildState: 'IN_BETA_TESTING' } } };
    if (path.includes('betaTesters')) return { data: [{ id: 'tester' }] };
    throw new Error(path);
  };
  assert.deepEqual(await distribute(request, { ...config, build: 12 }, { wait: async () => {} }), { id: 'build', testerCount: 1 });
  assert.deepEqual(calls.find(c => c.method === 'POST').body, { data: [{ type: 'builds', id: 'build' }] });
});
test('failed, expired and never-processed builds never distribute', async () => {
  for (const attrs of [{ processingState: 'INVALID' }, { processingState: 'VALID', expired: true }, { processingState: 'PROCESSING' }]) {
    const request = async path => { assert.ok(path.startsWith('/v1/builds?')); return { data: [{ id: 'bad', attributes: attrs }] }; };
    await assert.rejects(distribute(request, { ...config, build: 12 }, { attempts: 1, wait: async () => {} }));
  }
});
test('missing export compliance never claims availability', async () => {
  const request = async path => {
    if (path.startsWith('/v1/builds?')) return { data: [{ id: 'build', attributes: { processingState: 'VALID' } }] };
    if (path === '/v1/betaGroups?filter[app]=1&filter[builds]=build&filter[id]=group&limit=200') return { data: [{ id: 'group' }] };
    if (path.includes('betaTesters')) return { data: [{ id: 'tester' }] };
    return { data: { attributes: { internalBuildState: 'MISSING_EXPORT_COMPLIANCE' } } };
  };
  await assert.rejects(distribute(request, { ...config, build: 12 }, { wait: async () => {} }), /not yet available/);
});
test('credentials cannot follow pagination to another origin or redirects', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let called = false;
  const request = client({ ASC_API_KEY_ID: 'fixture', ASC_API_ISSUER_ID: 'fixture', ASC_API_KEY_P8_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') }, async (url, options) => {
    called = true; assert.equal(url.origin, 'https://api.appstoreconnect.apple.com'); assert.equal(options.redirect, 'error'); return new Response('{"data":[]}');
  });
  await assert.rejects(request('https://attacker.invalid/v1/builds'), /unexpected/);
  assert.equal(called, false); await request('/v1/apps'); assert.equal(called, true);
});
