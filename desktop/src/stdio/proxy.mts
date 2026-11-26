// The stdio MCP entry point's logic (#815). AI clients launch the app's own binary in node mode
// (ELECTRON_RUN_AS_NODE=1) with main.mjs; it forwards each JSON-RPC line from stdin to the desktop
// app's loopback server (Streamable HTTP, stateless, JSON responses) and writes the answer to stdout.
// The token is read from the app's userData on every request, so client configs hold no token and
// regenerating it breaks nothing. Node built-ins only: this file runs outside the asar archive.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PRODUCT = 'FreeAppStore';
export const DEFAULT_PORT = 47821;
export const NOT_RUNNING = "FreeAppStore isn't running. Open FreeAppStore and try again.";

/** Electron's default userData for this app: `app.getPath('appData')` + the product name. */
export function defaultUserData(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', PRODUCT);
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), PRODUCT);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), PRODUCT);
}

/** Where the proxy finds the app: the same overrides the app itself reads. */
export function target(env: NodeJS.ProcessEnv = process.env) {
  const userData = env.FAS_DESKTOP_USER_DATA || defaultUserData(process.platform, env);
  const port = Number(env.FAS_DESKTOP_PORT) || DEFAULT_PORT;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    readToken: () => readFileSync(join(userData, 'mcp-token'), 'utf8').trim(),
  };
}

type Id = string | number | null;
interface Message {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: unknown;
}

export interface ProxyOptions {
  url: string;
  readToken(): string;
  /** Makes sure the app is running (starting it if needed); resolves false when it isn't. */
  ensureApp(): Promise<boolean>;
  write(line: string): void;
  fetch?: typeof fetch;
}

const isUnreachable = (error: unknown) => {
  const code = (error as { cause?: { code?: string } }).cause?.code;
  return error instanceof TypeError || code === 'ECONNREFUSED' || code === 'ECONNRESET';
};

/** Returns a handler for one line read from stdin. */
export function createProxy({
  url,
  readToken,
  ensureApp,
  write,
  fetch = globalThis.fetch,
}: ProxyOptions) {
  let protocolVersion: string | undefined;

  /** An answer for a request the app couldn't take: a tool error for tool calls (the AI sees it), else a JSON-RPC error. */
  function fail(message: Message, text: string) {
    if (message.id === undefined) return; // a notification gets no answer
    if (message.method === 'tools/call') {
      write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text }], isError: true },
        }),
      );
    } else {
      write(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } }),
      );
    }
  }

  async function post(message: Message, body: string): Promise<Response> {
    let token = '';
    try {
      token = readToken();
    } catch {
      // No token file yet: the app has never run. ensureApp() starts it and it writes one.
    }
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(protocolVersion && message.method !== 'initialize'
          ? { 'mcp-protocol-version': protocolVersion }
          : {}),
      },
      body,
    });
  }

  async function forward(message: Message, body: string): Promise<void> {
    let response: Response;
    try {
      response = await post(message, body);
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      // The app isn't up: start it (or wait for it) once, then try again.
      if (!(await ensureApp())) return fail(message, NOT_RUNNING);
      try {
        response = await post(message, body);
      } catch {
        return fail(message, NOT_RUNNING);
      }
    }
    if (response.status === 202) return; // notification accepted
    const text = await response.text();
    if (!response.ok) {
      let reason = `FreeAppStore answered ${response.status}.`;
      try {
        reason = JSON.parse(text).error ?? reason;
      } catch {}
      return fail(message, reason);
    }
    // enableJsonResponse gives one JSON body; accept an SSE body too, one message per data line.
    const bodies = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
      : [text];
    for (const out of bodies) {
      if (!out) continue;
      if (message.method === 'initialize') {
        try {
          protocolVersion = JSON.parse(out).result?.protocolVersion ?? protocolVersion;
        } catch {}
      }
      write(out);
    }
  }

  return async function handle(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      );
      return;
    }
    try {
      await forward(message, line);
    } catch (error) {
      fail(message, `FreeAppStore proxy error: ${String(error)}`);
    }
  };
}
