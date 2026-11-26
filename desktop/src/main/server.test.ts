import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { Hub } from './hub.js';
import { PAUSED } from './mcp.js';
import { startServer } from './server.js';

const TOKEN = 'test-token-0123456789';
let server: Awaited<ReturnType<typeof startServer>>;
let hub: Hub;
let base: string;
let opened: string[];
let paused = false;
const sockets: WebSocket[] = [];
const clients: Client[] = [];

async function start(dev = false, timeoutMs = 30_000) {
  hub = new Hub(timeoutMs);
  opened = [];
  server = await startServer({
    hub,
    port: 0,
    dev,
    token: () => TOKEN,
    openApp: (id) => opened.push(id),
    openWaitMs: 50,
    paused: () => paused,
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function stop() {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

beforeEach(() => start());

afterEach(async () => {
  paused = false;
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const client of clients.splice(0)) await client.close();
  await stop();
});

async function mcp(token = TOKEN) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text: string }[])[0]!.text;

/** A fake app tab: connects with `origin`, registers `appId` and answers calls. */
function tab(
  origin: string,
  appId: string,
  answer = (args: Record<string, unknown>): unknown => ({ echoed: args.text }),
) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/bridge`, { headers: { origin } });
  sockets.push(ws);
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'call') return;
    ws.send(
      JSON.stringify({ type: 'result', id: message.id, ok: true, result: answer(message.args) }),
    );
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'register',
          appId,
          title: `${appId} tab`,
          tools: [
            {
              name: 'echo',
              description: 'Echo text',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        }),
      );
      resolve();
    });
    ws.on('error', reject);
  });
  return { ws, ready };
}

const closeCode = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );

describe('loopback server', () => {
  it('binds to 127.0.0.1 only', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('serves the four tools with titles and every hint', async () => {
    const { tools } = await (await mcp()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'app_call',
      'app_tools',
      'list_open_apps',
      'open_app',
    ]);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: false,
      });
    }
  });

  it('lists no apps when none is connected, and explains how to open one', async () => {
    const client = await mcp();
    expect(
      JSON.parse(textOf(await client.callTool({ name: 'list_open_apps', arguments: {} }))),
    ).toEqual([]);
    const result = await client.callTool({
      name: 'app_call',
      arguments: { app_id: 'spreadsheet', tool: 'sum' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "spreadsheet isn't open: call open_app or open https://spreadsheet.freeappstore.online and turn on Allow AI access.",
    );
    expect(hub.log[0]).toMatchObject({ tool: 'app_call', appId: 'spreadsheet', ok: false });
  });

  it('round-trips app_tools and app_call through a browser tab', async () => {
    const { ready } = tab('https://toy.freeappstore.online', 'toy');
    await ready;
    await vi.waitFor(() => expect(hub.find('toy')).toBeDefined());
    const client = await mcp();
    const apps = JSON.parse(
      textOf(await client.callTool({ name: 'list_open_apps', arguments: {} })),
    );
    expect(apps).toEqual([{ app_id: 'toy', title: 'toy tab', source: 'browser', tools: ['echo'] }]);
    const tools = JSON.parse(
      textOf(await client.callTool({ name: 'app_tools', arguments: { app_id: 'toy' } })),
    );
    expect(tools[0]).toMatchObject({ name: 'echo', inputSchema: { type: 'object' } });
    const result = await client.callTool({
      name: 'app_call',
      arguments: { app_id: 'toy', tool: 'echo', args: { text: 'hi' } },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ echoed: 'hi' });
    expect(hub.log[0]).toMatchObject({ tool: 'app_call', appId: 'toy', appTool: 'echo', ok: true });
  });

  it('open_app opens a window and reports when the app has not registered', async () => {
    const client = await mcp();
    const result = await client.callTool({ name: 'open_app', arguments: { app_id: 'notes' } });
    expect(opened).toEqual(['notes']);
    expect(textOf(result)).toContain('has not offered any tools yet');
    const bad = await client.callTool({ name: 'open_app', arguments: { app_id: '../x' } });
    expect(bad.isError).toBe(true);
    expect(opened).toEqual(['notes']);
  });
});

describe('pause', () => {
  it('fails every tool with the paused message and runs no app tool, until resumed', async () => {
    let calls = 0;
    const { ready } = tab('https://toy.freeappstore.online', 'toy', (args) => {
      calls++;
      return { echoed: args.text };
    });
    await ready;
    await vi.waitFor(() => expect(hub.find('toy')).toBeDefined());
    const client = await mcp();
    paused = true;
    for (const [name, args] of [
      ['list_open_apps', {}],
      ['app_tools', { app_id: 'toy' }],
      ['app_call', { app_id: 'toy', tool: 'echo', args: { text: 'hi' } }],
      ['open_app', { app_id: 'notes' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(PAUSED);
    }
    expect(calls).toBe(0);
    expect(opened).toEqual([]);
    expect(hub.log[0]).toMatchObject({ tool: 'open_app', ok: false, error: PAUSED });
    // The app stays registered while paused, so resuming works at once.
    paused = false;
    const result = await client.callTool({
      name: 'app_call',
      arguments: { app_id: 'toy', tool: 'echo', args: { text: 'hi' } },
    });
    expect(JSON.parse(textOf(result))).toEqual({ echoed: 'hi' });
    expect(calls).toBe(1);
  });
});

describe('MCP authentication', () => {
  const post = (headers: Record<string, string>) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('refuses a request without a token', async () => {
    expect((await post({})).status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    expect((await post({ authorization: 'Bearer nope' })).status).toBe(401);
    await expect(mcp('nope')).rejects.toThrow();
  });

  it('refuses any request carrying an Origin, even with the right token', async () => {
    const response = await post({
      authorization: `Bearer ${TOKEN}`,
      origin: 'https://spreadsheet.freeappstore.online',
    });
    expect(response.status).toBe(403);
  });

  it('refuses bodies over 1 MB', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});

describe('bridge WebSocket', () => {
  const refused = (origin?: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/bridge`, {
        headers: origin ? { origin } : {},
      });
      sockets.push(ws);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });

  it('refuses other origins, no origin, and localhost in release builds', async () => {
    expect(await refused('https://evil.com')).toBe(403);
    expect(await refused()).toBe(403);
    expect(await refused('http://localhost:5173')).toBe(403);
    expect(await refused('https://freeappstore.online')).toBe(403);
  });

  it('accepts localhost origins in dev builds', async () => {
    await stop();
    await start(true);
    expect(await refused('http://localhost:5173')).toBe(101);
  });

  it('closes a tab that claims another app id', async () => {
    const { ws, ready } = tab('https://spreadsheet.freeappstore.online', 'notes');
    await ready;
    expect(await closeCode(ws)).toEqual({
      code: 1008,
      reason: 'This page is spreadsheet, not notes.',
    });
    expect(hub.openApps()).toEqual([]);
  });

  it('closes a tab that sends more than 1 MB', async () => {
    const { ws, ready } = tab('https://toy.freeappstore.online', 'toy');
    await ready;
    ws.send('x'.repeat(1024 * 1024 + 1));
    expect((await closeCode(ws)).code).toBe(1009);
  });

  it('times calls out and drops the app when its tab closes', async () => {
    await stop();
    await start(false, 100);
    const silent = new WebSocket(`${base.replace('http', 'ws')}/bridge`, {
      headers: { origin: 'https://toy.freeappstore.online' },
    });
    sockets.push(silent);
    await new Promise((resolve) => silent.on('open', resolve));
    silent.send(
      JSON.stringify({
        type: 'register',
        appId: 'toy',
        tools: [{ name: 'slow', description: '', inputSchema: { type: 'object' } }],
      }),
    );
    await vi.waitFor(() => expect(hub.find('toy')).toBeDefined());
    await expect(hub.call('toy', 'slow', {})).rejects.toThrow(
      'toy did not answer slow within 0.1 s',
    );
    const pending = hub.call('toy', 'slow', {});
    silent.close();
    await expect(pending).rejects.toThrow('toy closed before answering');
    await vi.waitFor(() => expect(hub.find('toy')).toBeUndefined());
  });

  it('routes to the newest tab of an app and explains unknown tools', async () => {
    const first = tab('https://toy.freeappstore.online', 'toy', () => 'first');
    await first.ready;
    await vi.waitFor(() => expect(hub.find('toy')).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = tab('https://toy.freeappstore.online', 'toy', () => 'second');
    await second.ready;
    await vi.waitFor(() => expect(hub.openApps()).toHaveLength(2));
    expect(await hub.call('toy', 'echo', {})).toBe('second');
    second.ws.close();
    await vi.waitFor(() => expect(hub.openApps()).toHaveLength(1));
    expect(await hub.call('toy', 'echo', {})).toBe('first');
    await expect(hub.call('toy', 'nope', {})).rejects.toThrow(
      'toy has no tool "nope". Its tools: echo. Call app_tools for their schemas.',
    );
  });
});
