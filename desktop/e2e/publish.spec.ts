import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, expect, test } from '@playwright/test';
import { homeWindow } from './home.js';

// Publish (#800): New app, Check, Publish and Push, run by the real bundled `fas` CLI against a stand-in API (never
// the real /v1/publish), with the CLI's sign-in in a temporary home and a local bare repository as the app's
// "GitHub" repository.
const here = new URL('.', import.meta.url);
const SHOTS = process.env.FAS_SHOTS_DIR ?? 'test-results/shots';
const SESSION = 'e2e.session';
const APP = 'tides-e2e';
let api: Server;
let root: string;
let electron: ElectronApplication | null = null;
let published: Record<string, unknown> | null = null;
const seen: string[] = [];

function serveApi(): Promise<Server> {
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${SESSION}`) return send(401, { error: 'no' });
    const app = {
      id: APP,
      ownerLogin: 'e2e-octo',
      createdAt: 1,
      category: 'Utilities',
      type: 'standalone',
      oneliner: 'Tide times',
      repo: null,
      demo: null,
      appUrl: `https://${APP}.freeappstore.online`,
      // The bare repository Push sends to (`<repoUrl>.git`).
      repoUrl: pathToFileURL(join(root, 'remote', APP)).href,
    };
    if (req.url === '/v1/apps/mine') return send(200, { apps: published ? [app] : [] });
    if (req.url === '/v1/publish' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        published = JSON.parse(body);
        send(200, { appUrl: app.appUrl, repoUrl: app.repoUrl, repoEmpty: true });
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv() });
const gitEnv = () => ({
  ...process.env,
  HOME: join(root, 'home'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'E2E',
  GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E',
  GIT_COMMITTER_EMAIL: 'e2e@example.com',
});

test.beforeAll(async () => {
  api = await serveApi();
  root = mkdtempSync(join(tmpdir(), 'fas-publish-e2e-'));
  for (const dir of ['user-data', 'home/.fas', 'apps', 'remote']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  // The CLI's sign-in, as `fas login` writes it.
  writeFileSync(
    join(root, 'home/.fas/config.json'),
    JSON.stringify({ github: { login: 'e2e-octo' }, session: { token: SESSION } }),
    { mode: 0o600 },
  );
  execFileSync('git', ['init', '-q', '--bare', join(root, 'remote', `${APP}.git`)]);
});

test.afterAll(async () => {
  await electron?.close();
  api?.close();
  rmSync(root, { recursive: true, force: true });
});

test('creates, checks, publishes and pushes an app with the bundled CLI', async () => {
  test.setTimeout(180_000);
  electron = await _electron.launch({
    args: ['.'],
    cwd: new URL('..', here).pathname,
    env: {
      ...gitEnv(),
      FAS_DESKTOP_USER_DATA: join(root, 'user-data'),
      FAS_DESKTOP_PORT: '47897',
      FAS_DEV_API_ORIGIN: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      FAS_DESKTOP_CLI_HOME: join(root, 'home'),
    } as Record<string, string>,
  });
  // The folder dialogs answer with the test's apps folder.
  await electron.evaluate(
    ({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    },
    join(root, 'apps'),
  );
  const page = await homeWindow(electron);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByTestId('publish-account')).toHaveText('Signed in as @e2e-octo');
  await expect(page.getByText('No published apps yet')).toBeVisible();

  // New app: fas init from the platform starter
  await page.getByRole('button', { name: 'New app' }).click();
  await page.locator('input[name="app-id"]').fill(APP);
  await page.getByRole('button', { name: 'Create' }).click();
  const status = page.getByTestId('task-status');
  await expect(status).toHaveText('done', { timeout: 60_000 });
  const project = page.getByTestId(`project-${APP}`);
  await expect(project).toContainText('not published');
  const dir = join(root, 'apps', APP);
  expect(JSON.parse(readFileSync(join(dir, 'fas.json'), 'utf8')).appId).toBe(APP);

  // Check: fas check --json
  await project.getByRole('button', { name: 'Check' }).click();
  await expect(project.getByTestId('check-summary')).toContainText('Ready to publish', {
    timeout: 60_000,
  });

  // Publish: fas publish against the stand-in
  await project.getByRole('button', { name: 'Publish…' }).click();
  await project.locator('select[name="category"]').selectOption('Utilities');
  await project.locator('input[name="oneliner"]').fill('Tide times');
  await project.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(project.getByText('published', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(status).toHaveText('done');
  expect(published).toMatchObject({
    name: APP,
    store: 'apps',
    category: 'Utilities',
    type: 'standalone',
    oneliner: 'Tide times',
  });
  // The deploy workflow is committed, so the push carries it
  expect(git(dir, 'ls-files', '.github/workflows/deploy.yml')).toContain('deploy.yml');
  await expect(page.getByTestId('my-apps')).toContainText(APP);

  // Push: main to the app's repository
  await project.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Push', exact: true })).toBeVisible();
  await expect(status).toHaveText('done', { timeout: 30_000 });
  const remote = join(root, 'remote', `${APP}.git`);
  expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'main'));

  // An edit: commit with a message and push
  writeFileSync(join(dir, 'web', 'NOTES.md'), 'Tides\n');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(project).toContainText('1 changed file');
  await project.locator('input[name="message"]').fill('Add notes');
  await project.getByRole('button', { name: 'Commit and push' }).click();
  await expect
    .poll(() => git(remote, 'log', '-1', '--format=%s', 'main').trim(), { timeout: 30_000 })
    .toBe('Add notes');
  await expect(project).not.toContainText('changed file');
  await page.screenshot({ path: join(SHOTS, 'publish.png') });
  expect(seen).toContain('POST /v1/publish');
});
