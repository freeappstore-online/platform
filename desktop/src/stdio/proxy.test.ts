import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../main/hub.js';
import { PAUSED } from '../main/mcp.js';
import { startServer } from '../main/server.js';
import { createProxy, DEFAULT_PORT, defaultUserData, NOT_RUNNING, target } from './proxy.mjs';

let server: Awaited<ReturnType<typeof startServer>> | null = null;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server!.close(resolve));
  server = null;
});

let token = 'proxy-test-token';
let paused = false;

async function start() {
  server = await startServer({
    hub: new Hub(),
    port: 0,
    dev: false,
    token: () => token,
    openApp: () => {},
    paused: () => paused,
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** A proxy whose output lines are collected; sends each request and returns the parsed answer. */
function proxy(url: string, ensureApp = async () => false) {
  const out: string[] = [];
  const handle = createProxy({
    url,
    readToken: () => token,
    ensureApp,
    write: (line) => out.push(line),
  });
  return {
    out,
    async send(message: object) {
      const before = out.length;
      await handle(JSON.stringify({ jsonrpc: '2.0', ...message }));
      return out.slice(before).map((line) => JSON.parse(line));
    },
  };
}

const initialize = {
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

describe('stdio proxy', () => {
  it('forwards requests to the server with the token from userData', async () => {
    const p = proxy(await start());
    const [init] = await p.send(initialize);
    expect(init.result.serverInfo.name).toBe('FreeAppStore desktop');
    expect(await p.send({ method: 'notifications/initialized' })).toEqual([]);
    const [list] = await p.send({ id: 2, method: 'tools/list' });
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'app_call',
      'app_tools',
      'list_open_apps',
      'open_app',
    ]);
    const [call] = await p.send({
      id: 3,
      method: 'tools/call',
      params: { name: 'list_open_apps', arguments: {} },
    });
    expect(call.result).toEqual({ content: [{ type: 'text', text: '[]' }] });
  });

  it('reads the token on every request, so regenerating it breaks nothing', async () => {
    const p = proxy(await start());
    await p.send(initialize);
    token = 'regenerated-token';
    const [list] = await p.send({ id: 2, method: 'tools/list' });
    expect(list.result.tools).toHaveLength(4);
  });

  it('passes the paused tool error through, and recovers on resume', async () => {
    const p = proxy(await start());
    const call = { method: 'tools/call', params: { name: 'list_open_apps', arguments: {} } };
    paused = true;
    const [blocked] = await p.send({ id: 1, ...call });
    expect(blocked.result).toEqual({ content: [{ type: 'text', text: PAUSED }], isError: true });
    paused = false;
    const [ok] = await p.send({ id: 2, ...call });
    expect(ok.result.isError).toBeUndefined();
  });

  it('starts the app when it is not running, then retries', async () => {
    // A port nothing listens on, until ensureApp "starts" the app there.
    const url = await start();
    const real = server!;
    const port = (real.address() as AddressInfo).port;
    real.closeAllConnections();
    await new Promise((resolve) => real.close(resolve));
    server = null;
    let started = 0;
    const p = proxy(url, async () => {
      started++;
      server = await startServer({
        hub: new Hub(),
        port,
        dev: false,
        token: () => token,
        openApp: () => {},
      });
      return true;
    });
    const [list] = await p.send({ id: 1, method: 'tools/list' });
    expect(started).toBe(1);
    expect(list.result.tools).toHaveLength(4);
  });

  it('answers with a clear error when the app is not running and cannot start', async () => {
    const p = proxy('http://127.0.0.1:9/mcp');
    const [call] = await p.send({
      id: 1,
      method: 'tools/call',
      params: { name: 'list_open_apps', arguments: {} },
    });
    expect(call.result).toEqual({ content: [{ type: 'text', text: NOT_RUNNING }], isError: true });
    const [list] = await p.send({ id: 2, method: 'tools/list' });
    expect(list.error).toEqual({ code: -32000, message: NOT_RUNNING });
    expect(await p.send({ method: 'notifications/initialized' })).toEqual([]);
  });

  it('reports a refused token as an error', async () => {
    const url = await start();
    const out: string[] = [];
    const handle = createProxy({
      url,
      readToken: () => 'wrong',
      ensureApp: async () => true,
      write: (line) => out.push(line),
    });
    await handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }));
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 7, error: { code: -32000 } });
  });

  it("finds the app's userData and port like Electron does", () => {
    expect(defaultUserData('darwin', {}, '/Users/me')).toBe(
      '/Users/me/Library/Application Support/FreeAppStore',
    );
    expect(defaultUserData('linux', {}, '/home/me')).toBe('/home/me/.config/FreeAppStore');
    expect(defaultUserData('linux', { XDG_CONFIG_HOME: '/x' }, '/home/me')).toBe('/x/FreeAppStore');
    expect(target({}).url).toBe(`http://127.0.0.1:${DEFAULT_PORT}/mcp`);
    expect(target({ FAS_DESKTOP_PORT: '47899' }).url).toBe('http://127.0.0.1:47899/mcp');
  });
});
