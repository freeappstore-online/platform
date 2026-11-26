import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, expect, test } from '@playwright/test';

// The signed-in profile (#829) against a stand-in /native/me, and Sign out revoking the credential.
const here = new URL('.', import.meta.url);
const SHOTS = process.env.FAS_SHOTS_DIR ?? 'test-results/shots';
let api: Server;
let userData: string;
let electron: ElectronApplication;
const seen: string[] = [];

function serveApi(): Promise<Server> {
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== 'Bearer ndev_e2e') return send(401, { error: 'no' });
    if (req.url === '/v1/native/me')
      return send(200, {
        user: {
          id: 'gh:2824906',
          name: 'serge-ivo',
          login: 'serge-ivo',
          provider: 'github',
          avatarUrl: 'https://avatars.githubusercontent.com/u/2824906',
          email: null,
          roles: ['user', 'creator', 'admin'],
          appCount: 150,
        },
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
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test.beforeAll(async () => {
  api = await serveApi();
  userData = mkdtempSync(join(tmpdir(), 'fas-account-e2e-'));
  writeFileSync(join(userData, 'device-token'), 'ndev_e2e', { mode: 0o600 });
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
});

test.afterAll(async () => {
  await electron?.close();
  api?.close();
  rmSync(userData, { recursive: true, force: true });
});

test('shows the account in the header and in full, and Sign out revokes this computer', async () => {
  const home = await electron.firstWindow();
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
  await expect(home.getByRole('link', { name: "What's new" })).toHaveAttribute(
    'href',
    /\/releases\/tag\/desktop-v\d+\.\d+\.\d+$/,
  );
  await home.screenshot({ path: join(SHOTS, 'account.png') });

  await home.getByRole('button', { name: 'Sign out' }).click();
  await home.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(summary).toHaveText('Sign in');
  await expect(home.getByRole('button', { name: 'Connect this computer' })).toBeVisible();
  expect(seen).toContain('DELETE /v1/native/device');
});
