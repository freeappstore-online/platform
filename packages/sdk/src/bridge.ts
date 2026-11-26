/**
 * Local AI bridge (`@freeappstore/sdk/bridge`): lets an AI client on the user's
 * machine (Claude Code, Claude Desktop) call tools this app defines, through the
 * FreeAppStore desktop app's local MCP server. The tools run here, in the tab, on
 * the app's local data; nothing goes to a server.
 *
 * Inside a FreeAppStore desktop window the bridge uses the window's IPC channel.
 * In a normal browser tab it connects to the desktop app over
 * `ws://127.0.0.1:47821/bridge`, and reconnects quietly while enabled.
 */

/** JSON Schema describing a tool's arguments (an object schema). */
export type JsonSchema = { type?: string } & Record<string, unknown>;

export interface AppTool {
  /** Tool name, unique within the app, e.g. `read_range`. */
  name: string;
  /** What the tool does and when to use it; the AI reads this. */
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: JsonSchema;
  /** Runs the tool. Return any JSON-serialisable value; throw to report an error. */
  // biome-ignore lint/suspicious/noExplicitAny: the app's own inputSchema describes the arguments
  handler: (args: Record<string, any>) => unknown;
}

/** `connected`: the desktop app can call the tools. `rejected`: it refused this app (no retry). */
export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'rejected';

export interface ExposeToolsOptions {
  tools: AppTool[];
  /** Whether the AI may call the tools now, e.g. an "Allow AI access" toggle. Default true. */
  enabled?: boolean;
  /** Defaults to the `<id>` of `<id>.freeappstore.online`; required on other hosts (local dev). */
  appId?: string;
  onStatus?: (status: BridgeStatus) => void;
  /** Desktop bridge URL. Default `ws://127.0.0.1:47821/bridge`. */
  url?: string;
}

export interface ToolBridge {
  readonly status: BridgeStatus;
  /** Turn AI access on or off without recreating the bridge. */
  setEnabled(enabled: boolean): void;
  /** Stop for good: disconnects and stops reconnecting. */
  close(): void;
}

/** The IPC channel the desktop app's preload exposes to its app windows. */
export interface DesktopBridgeChannel {
  send(message: string): void;
  onMessage(listener: (message: string) => void): void;
}

export const BRIDGE_URL = 'ws://127.0.0.1:47821/bridge';
/** Largest message either side sends or accepts, in bytes. */
export const BRIDGE_MAX_MESSAGE_BYTES = 1024 * 1024;
/** WebSocket close code the desktop app uses when it refuses an app. */
const POLICY_VIOLATION = 1008;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

type HostMessage = { type: 'call'; id: string; tool: string; args?: Record<string, unknown> };

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function defaultAppId(): string | undefined {
  const host = typeof location === 'undefined' ? '' : location.hostname;
  return /^([a-z0-9][a-z0-9-]*)\.freeappstore\.online$/.exec(host)?.[1];
}

/**
 * Offer `tools` to a local AI client through the FreeAppStore desktop app.
 *
 * ```ts
 * const bridge = exposeTools({
 *   enabled: allowAi,
 *   tools: [{
 *     name: 'sum_range',
 *     description: 'Sum the numbers in a range such as A1:A10.',
 *     inputSchema: { type: 'object', properties: { range: { type: 'string' } }, required: ['range'] },
 *     handler: ({ range }) => sheet.sum(range),
 *   }],
 * });
 * bridge.setEnabled(false);
 * ```
 */
export function exposeTools(options: ExposeToolsOptions): ToolBridge {
  const channel = (globalThis as { fasDesktopBridge?: DesktopBridgeChannel }).fasDesktopBridge;
  const appId = options.appId ?? defaultAppId();
  if (!channel && !appId) {
    throw new Error(
      'exposeTools: pass appId when the app is not served from <id>.freeappstore.online',
    );
  }
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  let enabled = options.enabled ?? true;
  let closed = false;
  let status: BridgeStatus = 'off';
  let socket: WebSocket | undefined;
  let retryDelay = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: BridgeStatus) => {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  };

  const registration = () =>
    JSON.stringify({
      type: 'register',
      ...(appId ? { appId } : {}),
      title: typeof document === 'undefined' ? '' : document.title,
      tools: options.tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });

  async function reply(message: HostMessage): Promise<string> {
    const tool = tools.get(message.tool);
    if (!tool) {
      const names = [...tools.keys()].join(', ') || 'none';
      return JSON.stringify({
        type: 'result',
        id: message.id,
        ok: false,
        error: `Unknown tool "${message.tool}". Tools: ${names}.`,
      });
    }
    try {
      const result = await tool.handler(message.args ?? {});
      const text = JSON.stringify({
        type: 'result',
        id: message.id,
        ok: true,
        result: result ?? null,
      });
      if (byteLength(text) <= BRIDGE_MAX_MESSAGE_BYTES) return text;
      return JSON.stringify({
        type: 'result',
        id: message.id,
        ok: false,
        error: `${message.tool} returned more than 1 MB. Ask for less data, e.g. a smaller range.`,
      });
    } catch (error) {
      return JSON.stringify({
        type: 'result',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function receive(text: string, send: (text: string) => void) {
    if (!enabled || byteLength(text) > BRIDGE_MAX_MESSAGE_BYTES) return;
    let message: HostMessage;
    try {
      message = JSON.parse(text) as HostMessage;
    } catch {
      return;
    }
    if (message?.type !== 'call' || typeof message.id !== 'string') return;
    send(await reply(message));
  }

  // ── Desktop window: IPC, no network ──────────────────────────
  if (channel) {
    channel.onMessage((text) => void receive(text, (out) => channel.send(out)));
    const apply = () => {
      if (closed) return;
      channel.send(enabled ? registration() : JSON.stringify({ type: 'unregister' }));
      setStatus(enabled ? 'connected' : 'off');
    };
    if (enabled) apply();
    return {
      get status() {
        return status;
      },
      setEnabled(next) {
        if (closed || next === enabled) return;
        enabled = next;
        apply();
      },
      close() {
        if (closed) return;
        if (enabled) channel.send(JSON.stringify({ type: 'unregister' }));
        closed = true;
        setStatus('off');
      },
    };
  }

  // ── Browser tab: WebSocket to the desktop app ────────────────
  const url = options.url ?? BRIDGE_URL;

  function connect() {
    if (closed || !enabled || socket || typeof WebSocket === 'undefined') return;
    setStatus('connecting');
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      retryDelay = RETRY_MIN_MS;
      ws.send(registration());
      setStatus('connected');
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') void receive(event.data, (out) => ws.send(out));
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = undefined;
      if (event.code === POLICY_VIOLATION) {
        setStatus('rejected');
        return;
      }
      if (closed || !enabled) return setStatus('off');
      setStatus('connecting');
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    const ws = socket;
    socket = undefined;
    ws?.close();
    setStatus('off');
  }

  connect();
  return {
    get status() {
      return status;
    },
    setEnabled(next) {
      if (closed || next === enabled) return;
      enabled = next;
      if (enabled) {
        retryDelay = RETRY_MIN_MS;
        connect();
      } else disconnect();
    },
    close() {
      closed = true;
      disconnect();
    },
  };
}
