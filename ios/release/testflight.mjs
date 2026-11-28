import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://api.appstoreconnect.apple.com';
export function client(env = process.env, fetcher = fetch) {
  const key = createPrivateKey(Buffer.from(env.ASC_API_KEY_P8_BASE64, 'base64'));
  return async function request(path, method = 'GET', body) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error('Refusing an unexpected App Store Connect origin');
    const now = Math.floor(Date.now() / 1000);
    const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const unsigned = `${b64({ alg: 'ES256', kid: env.ASC_API_KEY_ID, typ: 'JWT' })}.${b64({ iss: env.ASC_API_ISSUER_ID, iat: now, exp: now + 300, aud: 'appstoreconnect-v1' })}`;
    const jwt = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const response = await fetcher(url, { method, headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`App Store Connect ${method} ${url.pathname}: HTTP ${response.status}`);
    return response.status === 204 ? {} : response.json();
  };
}
export async function list(request, path) {
  const result = [];
  for (let pages = 0; path; pages++) {
    if (pages >= 100) throw new Error('App Store Connect pagination exceeded limit');
    const response = await request(path); result.push(...response.data); path = response.links?.next;
  }
  return result;
}
export async function preflight(request, { appId, groupId, bundleId, version, minimum }) {
  const app = (await request(`/v1/apps/${appId}`)).data;
  if (app.attributes.bundleId !== bundleId) throw new Error('App Store Connect app does not match the expected bundle ID');
  const group = (await request(`/v1/betaGroups/${groupId}?include=app`)).data;
  if (!group.attributes.isInternalGroup || group.relationships.app.data.id !== appId) throw new Error('Select an internal TestFlight group belonging to this app');
  const testers = await list(request, `/v1/betaGroups/${groupId}/betaTesters?limit=200`);
  if (!testers.length) throw new Error('The internal TestFlight group has no testers; invite the intended Apple account first');
  const builds = await list(request, `/v1/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&limit=200`);
  const numbers = builds.map(b => b.attributes.version);
  if (numbers.some(n => !/^\d+$/.test(n))) throw new Error('Existing build numbers are not integers; choose a monotonic version explicitly');
  const build = Math.max(Number(minimum), ...numbers.map(n => Number(n) + 1));
  if (!Number.isSafeInteger(build) || build < 1 || build > 999999999) throw new Error('Invalid build number');
  return { build, testerCount: testers.length };
}
export async function distribute(request, { appId, groupId, version, build }, { wait = ms => new Promise(r => setTimeout(r, ms)), attempts = 90 } = {}) {
  let id;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const builds = await list(request, `/v1/builds?filter[app]=${appId}&filter[version]=${build}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&limit=200`);
    if (builds.length > 1) throw new Error('Ambiguous uploaded build');
    if (builds.length) {
      const found = builds[0];
      if (found.attributes.expired || ['FAILED', 'INVALID'].includes(found.attributes.processingState)) throw new Error('Apple rejected or expired the uploaded build');
      if (found.attributes.processingState === 'VALID') { id = found.id; break; }
    }
    await wait(20_000);
  }
  if (!id) throw new Error('Apple has not finished processing the build; no tester availability claimed');
  const groups = await list(request, `/v1/builds/${id}/betaGroups?limit=200`);
  if (!groups.some(g => g.id === groupId)) await request(`/v1/betaGroups/${groupId}/relationships/builds`, 'POST', { data: [{ type: 'builds', id }] });
  for (let attempt = 0; attempt < 12; attempt++) {
    const detail = (await request(`/v1/builds/${id}/buildBetaDetail`)).data;
    const assigned = await list(request, `/v1/builds/${id}/betaGroups?limit=200`);
    const testers = await list(request, `/v1/betaGroups/${groupId}/betaTesters?limit=200`);
    if (detail.attributes.internalBuildState === 'IN_BETA_TESTING' && assigned.some(g => g.id === groupId) && testers.length) return { id, testerCount: testers.length };
    await wait(10_000);
  }
  throw new Error('Build uploaded but not yet available to the configured internal testers; inspect TestFlight compliance and group status');
}
async function main() {
  const env = process.env;
  for (const name of ['ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'ASC_API_KEY_P8_BASE64', 'ASC_APP_ID', 'ASC_BETA_GROUP_ID', 'IOS_MARKETING_VERSION']) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  for (const name of ['ASC_APP_ID', 'ASC_BETA_GROUP_ID']) if (!/^[A-Za-z0-9-]+$/.test(env[name])) throw new Error(`Invalid ${name}`);
  const request = client(env);
  const config = { appId: env.ASC_APP_ID, groupId: env.ASC_BETA_GROUP_ID, bundleId: 'online.freeappstore.companion', version: env.IOS_MARKETING_VERSION };
  if (process.argv[2] === 'preflight') {
    const result = await preflight(request, { ...config, minimum: env.GITHUB_RUN_NUMBER || 1 });
    if (!env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
    appendFileSync(env.GITHUB_ENV, `IOS_BUILD_NUMBER=${result.build}\n`);
    console.log(`Validated app and internal tester group (${result.testerCount} testers); build ${result.build}`);
  } else if (process.argv[2] === 'verify') {
    if (!/^\d+$/.test(env.IOS_BUILD_NUMBER || '')) throw new Error('Invalid IOS_BUILD_NUMBER');
    const result = await distribute(request, { ...config, build: env.IOS_BUILD_NUMBER });
    const message = `TestFlight ${config.version} (${env.IOS_BUILD_NUMBER}) processed and available to internal group (${result.testerCount} testers). App: https://appstoreconnect.apple.com/apps/${config.appId}/testflight\n`;
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, message);
  } else throw new Error('Use preflight or verify');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
