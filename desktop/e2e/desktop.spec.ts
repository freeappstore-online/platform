import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  _electron,
  type Browser,
  chromium,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from '@playwright/test';
import ts from 'typescript';
import WebSocket from 'ws';

const here = new URL('.', import.meta.url);
// The SDK bridge source from this repo, compiled on the fly: the test page runs the real code.
const SDK_BRIDGE = new URL('../../packages/sdk/src/bridge.ts', here);
const SHOTS = process.env.FAS_SHOTS_DIR ?? 'test-results/shots';

let fixture: Server;
let fixtureOrigin: string;
let port: number;
let userData: string;
let electron: ElectronApplication;
let home: Page;
let browser: Browser;
let mcp: Client;
let token: string;

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function serveFixture(): Promise<Server> {
  const bridge = ts.transpileModule(readFileSync(SDK_BRIDGE, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const page = readFileSync(new URL('fixture/index.html', here), 'utf8');
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/bridge.js')
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(bridge);
    else if (path === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    else res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function connect(authToken: string) {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
    }),
  );
  return client;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await mcp.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { text, isError: Boolean(result.isError) };
}

const openApps = async () => JSON.parse((await call('list_open_apps')).text);

test.beforeAll(async () => {
  fixture = await serveFixture();
  fixtureOrigin = `http://localhost:${(fixture.address() as AddressInfo).port}`;
  port = await freePort();
  userData = mkdtempSync(join(tmpdir(), 'fas-desktop-e2e-'));
  electron = await _electron.launch({
    args: ['.'],
    cwd: new URL('..', here).pathname,
    env: {
      ...process.env,
      FAS_DESKTOP_PORT: String(port),
      FAS_DESKTOP_USER_DATA: userData,
      FAS_DEV_APP_ORIGIN: fixtureOrigin,
    },
  });
  home = await electron.firstWindow();
  await home.waitForSelector('[data-testid="setup-command"]');
  token = readFileSync(join(userData, 'mcp-token'), 'utf8');
  mcp = await connect(token);
  // evil.test resolves to the fixture server, so a real page can try from a foreign origin.
  browser = await chromium.launch({ args: ['--host-resolver-rules=MAP evil.test 127.0.0.1'] });
});

test.afterAll(async () => {
  await mcp?.close();
  await browser?.close();
  await electron?.close();
  fixture?.close();
  rmSync(userData, { recursive: true, force: true });
});

test('home screen shows the setup command, in light and dark', async () => {
  await expect(home.getByTestId('setup-command')).toHaveText(
    `claude mcp add --transport http fas http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`,
  );
  await expect(home.getByText('No apps connected')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await home.evaluate((t) => {
      if (t === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await home.screenshot({ path: join(SHOTS, `home-${theme}.png`) });
  }
});

test('the Store tab lists apps from registry.json (needs the network)', async () => {
  await home.getByRole('button', { name: 'Store', exact: true }).click();
  await expect(home.getByRole('button', { name: 'Open' }).first()).toBeVisible({ timeout: 15_000 });
  await home.screenshot({ path: join(SHOTS, 'store-dark.png') });
  await home.getByRole('button', { name: 'Home', exact: true }).click();
});

test('the token file is private to the user', async () => {
  const { statSync } = await import('node:fs');
  expect(statSync(join(userData, 'mcp-token')).mode & 0o777).toBe(0o600);
});

test('list_open_apps starts empty', async () => {
  expect(await openApps()).toEqual([]);
});

test('a browser tab exposes tools over the WebSocket', async () => {
  const tab = await browser.newPage();
  await tab.goto(`${fixtureOrigin}/?app=toyweb&ws=ws://127.0.0.1:${port}/bridge`);
  await expect(tab.locator('#status')).toHaveText('connected');
  await expect
    .poll(openApps)
    .toEqual([{ app_id: 'toyweb', title: 'Toy app', source: 'browser', tools: ['echo'] }]);
  const tools = JSON.parse((await call('app_tools', { app_id: 'toyweb' })).text);
  expect(tools[0]).toMatchObject({ name: 'echo', inputSchema: { required: ['text'] } });
  const result = await call('app_call', { app_id: 'toyweb', tool: 'echo', args: { text: 'hi' } });
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.text)).toEqual({ echoed: 'hi', where: 'browser' });
  await tab.close();
  await expect.poll(openApps).toEqual([]);
});

test('open_app opens a desktop window whose tools go over IPC, under the window’s own app id', async () => {
  const opened = await call('open_app', { app_id: 'toy' });
  expect(opened.text).toBe('toy is open. Tools: echo. Call app_tools for their schemas.');
  // The page claimed "impostor"; the desktop registers it as the app its window was opened for.
  expect(await openApps()).toEqual([
    { app_id: 'toy', title: 'Toy app', source: 'desktop', tools: ['echo'] },
  ]);
  const tools = JSON.parse((await call('app_tools', { app_id: 'toy' })).text);
  expect(tools.map((t: { name: string }) => t.name)).toEqual(['echo']);
  const result = await call('app_call', { app_id: 'toy', tool: 'echo', args: { text: 'yo' } });
  expect(JSON.parse(result.text)).toEqual({ echoed: 'yo', where: 'desktop' });

  // The window is sandboxed, isolated and only has the bridge.
  const appWindow = electron.windows().find((w) => w !== home)!;
  expect(
    await appWindow.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys((globalThis as { fasDesktopBridge?: object }).fasDesktopBridge ?? {}),
    })),
  ).toEqual({ require: 'undefined', process: 'undefined', bridge: ['send', 'onMessage'] });

  await expect(home.getByText('Desktop window')).toBeVisible();
  await home.getByRole('button', { name: 'Activity' }).click();
  await expect(home.getByText('echo', { exact: false }).first()).toBeVisible();
  await home.screenshot({ path: join(SHOTS, 'activity-dark.png') });
  await home.getByRole('button', { name: 'Home', exact: true }).click();
  await home.screenshot({ path: join(SHOTS, 'home-connected-dark.png') });

  await appWindow.close();
  await expect.poll(openApps).toEqual([]);
  const closed = await call('app_call', { app_id: 'toy', tool: 'echo', args: { text: 'x' } });
  expect(closed).toEqual({
    isError: true,
    text: "toy isn't open: call open_app or open https://toy.freeappstore.online and turn on Allow AI access.",
  });
});

test('MCP refuses no token, a wrong token, and requests with an Origin', async () => {
  const post = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }).then((r) => r.status);
  expect(await post({})).toBe(401);
  expect(await post({ authorization: 'Bearer wrong' })).toBe(401);
  expect(await post({ authorization: `Bearer ${token}`, origin: 'https://evil.com' })).toBe(403);
  await expect(connect('wrong')).rejects.toThrow();
  // A web page can't reach it either: the browser sends an Origin.
  const page = await browser.newPage();
  await page.goto(fixtureOrigin);
  const status = await page.evaluate(
    async ([url, auth]) =>
      fetch(url!, { method: 'POST', headers: { authorization: auth! }, body: '{}' })
        .then((r) => r.status)
        .catch(() => 0),
    [`http://127.0.0.1:${port}/mcp`, `Bearer ${token}`],
  );
  expect(status).not.toBe(200);
  await page.close();
});

test('the bridge refuses foreign origins and apps claiming another id', async () => {
  const bridge = `ws://127.0.0.1:${port}/bridge`;
  const refused = (origin: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(bridge, { headers: { origin } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        resolve(101);
        ws.close();
      });
      ws.on('error', () => {});
    });
  expect(await refused('https://evil.com')).toBe(403);
  expect(await refused('https://freeappstore.online.evil.com')).toBe(403);

  const ws = new WebSocket(bridge, {
    headers: { origin: 'https://spreadsheet.freeappstore.online' },
  });
  await new Promise((resolve) => ws.on('open', resolve));
  const closed = new Promise<[number, string]>((resolve) =>
    ws.on('close', (code, reason) => resolve([code, reason.toString()])),
  );
  ws.send(JSON.stringify({ type: 'register', appId: 'notes', title: 'x', tools: [] }));
  expect(await closed).toEqual([1008, 'This page is spreadsheet, not notes.']);
  expect(await openApps()).toEqual([]);

  // A real page on a foreign origin: the browser's own Origin header gets it refused.
  const fixturePort = (fixture.address() as AddressInfo).port;
  const page = await browser.newPage();
  await page.goto(`http://evil.test:${fixturePort}/?app=toyweb&ws=${bridge}`);
  await expect(page.locator('#status')).toHaveText('connecting');
  await page.waitForTimeout(2500);
  await expect(page.locator('#status')).toHaveText('connecting');
  expect(await openApps()).toEqual([]);
  await page.close();
});
