import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, expect, test } from '@playwright/test';
import { homeWindow } from './home.js';

// The signed-in profile (#829) against a stand-in /native/me, Sign out revoking the credential, the
// version sent with every call (#833), Add a phone (#845), and Contribute's history and opt-ins
// never passing to another account (#848).
const here = new URL('.', import.meta.url);
const SHOTS = process.env.FAS_SHOTS_DIR ?? 'test-results/shots';
let api: Server;
let userData: string;
let electron: ElectronApplication | null = null;
const seen: string[] = [];
const versions: (string | undefined)[] = [];

const user = (id: string, name: string) => ({
  id,
  name,
  login: name,
  provider: 'github',
  avatarUrl: id === 'gh:2824906' ? 'https://avatars.githubusercontent.com/u/2824906' : null,
  email: null,
  roles: ['user', 'creator', 'admin'],
  appCount: 150,
});
/** Credentials the stand-in knows: A twice (two connections of one account), and B. */
const ACCOUNTS: Record<string, ReturnType<typeof user>> = {
  'Bearer ndev_e2e': user('gh:2824906', 'serge-ivo'),
  'Bearer ndev_a2': user('gh:2824906', 'serge-ivo'),
  'Bearer ndev_b': user('gh:42', 'bea'),
};

function serveApi(): Promise<Server> {
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    versions.push(req.headers['x-fas-app-version'] as string | undefined);
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const account = ACCOUNTS[req.headers.authorization ?? ''];
    if (!account) return send(401, { error: 'no' });
    if (req.url === '/v1/native/me')
      return send(200, {
        user: account,
        device: {
          id: 'd1',
          label: 'FreeAppStore desktop (Mac)',
          createdAt: Date.UTC(2026, 10, 27),
          expiresAt: Date.UTC(2027, 1, 25),
        },
        apps: [],
      });
    if (req.url === '/v1/native/device' && req.method === 'DELETE')
      return send(200, { disconnected: true });
    if (req.url === '/v1/native/pair-codes' && req.method === 'POST')
      return send(200, {
        code: 'ABCD-EFGH-JKMN-PQRS',
        url: 'freeappstore://native/pair?code=ABCDEFGHJKMNPQRS',
        expiresAt: Date.now() + 300_000,
      });
    if (req.url === '/v1/generation/open') return send(200, { apps: [] });
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(token: string | null) {
  await electron?.close();
  if (token) writeFileSync(join(userData, 'device-token'), token, { mode: 0o600 });
  else rmSync(join(userData, 'device-token'), { force: true });
  electron = await _electron.launch({
    args: ['.'],
    cwd: new URL('..', here).pathname,
    env: {
      ...process.env,
      FAS_DESKTOP_USER_DATA: userData,
      FAS_DESKTOP_PORT: '47898',
      FAS_DEV_API_ORIGIN: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    } as Record<string, string>,
  });
  return homeWindow(electron);
}

const HISTORY = 'contribute-history.json';
/** A's Contribute record: one upload with its report note, its kept audio, and A's opt-in. */
function seedContribute(account: string | null) {
  writeFileSync(
    join(userData, HISTORY),
    JSON.stringify([
      {
        appId: 'books',
        jobId: 'j1',
        key: 'book/0',
        at: Date.UTC(2026, 10, 26),
        outcome: 'submitted',
        reason: null,
        text: 'A secret chapter of A.',
        chars: 22,
        record: { runner: 'desktop', reason: 'submitted' },
        verdict: {
          submissionId: 's1',
          status: 'accepted',
          reason: null,
          durationMs: 1000,
          report: { good: false, note: 'A’s private note' },
        },
      },
    ]),
  );
  mkdirSync(join(userData, 'contribute-audio'), { recursive: true });
  writeFileSync(join(userData, 'contribute-audio', 'books--j1.m4a'), 'audio');
  writeFileSync(join(userData, 'contribute-audio', 'books--j1.json'), '{"segments":[]}');
  const settings = existsSync(join(userData, 'settings.json'))
    ? JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
    : { openAtLogin: false };
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ ...settings, contributeApps: ['books'], contributeAccount: account }),
  );
}
const settings = () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
const contributeFiles = () =>
  [HISTORY, 'contribute-audio'].filter((f) => existsSync(join(userData, f)));

test.beforeAll(async () => {
  api = await serveApi();
});

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'fas-account-e2e-'));
  seen.length = 0;
  versions.length = 0;
});

test.afterEach(async () => {
  await electron?.close();
  electron = null;
  rmSync(userData, { recursive: true, force: true });
});

test.afterAll(() => {
  api?.close();
});

test('shows the account in the header and in full, and Sign out revokes this computer', async () => {
  seedContribute('gh:2824906');
  const home = await launch('ndev_e2e');
  const summary = home.getByTestId('profile-summary');
  await expect(summary).toHaveText('serge-ivo');
  await summary.click();
  await expect(home.getByTestId('profile-name')).toHaveText('serge-ivo');
  await expect(home.getByText('@serge-ivo')).toBeVisible();
  await expect(home.getByText('gh:2824906')).toBeVisible();
  await expect(home.getByText('user, creator, admin')).toBeVisible();
  await expect(home.getByText('FreeAppStore desktop (Mac)')).toBeVisible();
  await expect(home.getByRole('link', { name: 'Delete account' })).toHaveAttribute(
    'href',
    'https://freeappstore.online/app/settings?delete-account=1',
  );
  // A local build: package.json's version, "dev" and the commit, with its release notes (#832).
  await expect(home.getByTestId('app-version')).toHaveText(/^\d+\.\d+\.\d+ \(dev, [0-9a-f]{7}\)$/);
  await expect(home.getByRole('button', { name: "What's new" })).toBeVisible();
  // Every call says which version this is (#833)
  const label = await home.getByTestId('app-version').textContent();
  expect(versions.length).toBeGreaterThan(0);
  expect(versions.every((v) => v === label)).toBe(true);

  // Add a phone (#845): the code as a QR and as text
  await home.getByRole('button', { name: 'Show a code' }).click();
  await expect(home.getByTestId('pair-code')).toHaveText('ABCD-EFGH-JKMN-PQRS');
  await expect(home.getByRole('img', { name: 'Pairing QR code' })).toBeVisible();
  expect(seen).toContain('POST /v1/native/pair-codes');
  await home.screenshot({ path: join(SHOTS, 'account.png') });

  await home.getByRole('button', { name: 'Sign out' }).click();
  await home.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(summary).toHaveText('Sign in');
  await expect(home.getByRole('button', { name: 'Connect this computer' })).toBeVisible();
  expect(seen).toContain('DELETE /v1/native/device');
  // An explicit sign-out deletes A's record, audio and opt-ins (#848)
  expect(contributeFiles()).toEqual([]);
  expect(settings()).toMatchObject({ contributeApps: [], contributeAccount: null });
});

test('an expired credential keeps the record for the same account only, never for another (#848)', async () => {
  seedContribute('gh:2824906');
  // Refused credential: signed out, the record stays for A to come back to
  let home = await launch('ndev_expired');
  await expect(home.getByTestId('profile-summary')).toHaveText('Sign in');
  await expect.poll(() => existsSync(join(userData, 'device-token'))).toBe(false);
  expect(contributeFiles()).toEqual([HISTORY, 'contribute-audio']);

  // A connects again (a new credential, after a restart): A's record is back
  home = await launch('ndev_a2');
  await home.getByRole('button', { name: 'Contribute', exact: true }).click();
  await expect(home.getByText('book/0')).toBeVisible();

  // Expired again, then B connects: nothing of A's is shown, kept or used
  home = await launch('ndev_expired');
  await expect(home.getByTestId('profile-summary')).toHaveText('Sign in');
  seen.length = 0;
  home = await launch('ndev_b');
  await expect(home.getByTestId('profile-summary')).toHaveText(/bea$/);
  await expect.poll(() => settings().contributeAccount).toBe('gh:42');
  expect(contributeFiles()).toEqual([]);
  expect(settings().contributeApps).toEqual([]);
  await home.getByRole('button', { name: 'Contribute', exact: true }).click();
  await expect(home.getByText('Nothing generated on this computer yet.')).toBeVisible();
  await expect(home.getByText('book/0')).toHaveCount(0);
  expect(seen.filter((r) => r.endsWith('/claim'))).toEqual([]);
});

test('a record left by a sign-out before #848 is deleted at the next start', async () => {
  seedContribute(null);
  const home = await launch(null);
  await expect(home.getByTestId('profile-summary')).toHaveText('Sign in');
  expect(contributeFiles()).toEqual([]);
  expect(settings()).toMatchObject({ contributeApps: [], contributeAccount: null });
});
