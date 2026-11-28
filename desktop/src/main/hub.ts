import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MAX_ACTIVITY } from './activity.js';
import { APP_ID } from './security.js';

/** Largest bridge message either side sends or accepts (matches the SDK). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const CALL_TIMEOUT_MS = 30_000;
const MAX_TOOLS = 100;

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One app page on the other end of the bridge: a desktop window (IPC) or a browser tab (WebSocket). */
export interface Peer {
  id: string;
  source: 'desktop' | 'browser';
  send(text: string): void;
  /** Ends the connection because the page broke the rules. */
  reject(reason: string): void;
  /**
   * The app id this peer is registered as, given the id the page claimed.
   * Desktop windows ignore the claim (the id comes from the window's URL); browser tabs must
   * claim their own origin's app. Returns an error message to refuse.
   */
  resolveAppId(claimed: unknown): { appId: string } | { error: string };
}

export interface OpenApp {
  appId: string;
  title: string;
  source: Peer['source'];
  tools: ToolInfo[];
}

export interface LogEntry {
  id: number;
  at: number;
  tool: string;
  appId?: string;
  appTool?: string;
  ok: boolean;
  error?: string;
}

interface Registration extends OpenApp {
  peer: Peer;
  registeredAt: number;
}

interface Pending {
  peerId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** An error the AI should see as-is, as an MCP tool error. */
export class BridgeError extends Error {}

export const notOpen = (appId: string) =>
  `${appId} isn't open: call open_app or open https://${appId}.freeappstore.online and turn on Allow AI access.`;

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function parseTools(value: unknown): ToolInfo[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return null;
  const tools: ToolInfo[] = [];
  for (const tool of value) {
    const { name, description, inputSchema } = (tool ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) return null;
    if (typeof description !== 'string') return null;
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return null;
    tools.push({ name, description, inputSchema: inputSchema as Record<string, unknown> });
  }
  return tools;
}

/**
 * The apps connected over the bridge, the calls in flight to them, and a log of AI calls.
 * Emits `change` whenever any of that changes.
 */
export class Hub extends EventEmitter {
  private registrations = new Map<string, Registration>();
  private pending = new Map<string, Pending>();
  readonly log: LogEntry[] = [];
  private logId = 0;

  constructor(private readonly timeoutMs = CALL_TIMEOUT_MS) {
    super();
  }

  /** Handles one message from a peer. */
  receive(peer: Peer, text: string) {
    if (byteLength(text) > MAX_MESSAGE_BYTES) return peer.reject('Message larger than 1 MB.');
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return peer.reject('Malformed message.');
    }
    switch (message?.type) {
      case 'register': {
        const resolved = peer.resolveAppId(message.appId);
        if ('error' in resolved) return peer.reject(resolved.error);
        const tools = parseTools(message.tools);
        if (!tools) return peer.reject('Invalid tool list.');
        this.registrations.set(peer.id, {
          peer,
          appId: resolved.appId,
          title: typeof message.title === 'string' ? message.title.slice(0, 200) : '',
          source: peer.source,
          tools,
          registeredAt: Date.now(),
        });
        this.emit('change');
        return;
      }
      case 'unregister':
        return this.disconnect(peer.id);
      case 'result': {
        const call = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
        if (!call || call.peerId !== peer.id) return;
        this.pending.delete(message.id as string);
        clearTimeout(call.timer);
        if (message.ok === true) call.resolve(message.result);
        else call.reject(new BridgeError(String(message.error ?? 'The app reported an error.')));
        return;
      }
      default:
        return peer.reject('Unknown message type.');
    }
  }

  /** Forgets a peer (closed tab or window, or page turned AI access off). */
  disconnect(peerId: string): void {
    const registration = this.registrations.get(peerId);
    this.registrations.delete(peerId);
    for (const [id, call] of this.pending) {
      if (call.peerId !== peerId) continue;
      this.pending.delete(id);
      clearTimeout(call.timer);
      call.reject(
        new BridgeError(
          `${registration?.appId ?? 'The app'} closed before answering. Call it again.`,
        ),
      );
    }
    if (registration) this.emit('change');
  }

  openApps(): OpenApp[] {
    return [...this.registrations.values()].map(({ appId, title, source, tools }) => ({
      appId,
      title,
      source,
      tools,
    }));
  }

  /** The newest registration for an app (a later tab or window wins). */
  find(appId: string): Registration | undefined {
    let found: Registration | undefined;
    for (const r of this.registrations.values()) {
      if (r.appId === appId && (!found || r.registeredAt >= found.registeredAt)) found = r;
    }
    return found;
  }

  /** Runs one of an open app's tools and resolves with its result. */
  call(appId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!APP_ID.test(appId)) return Promise.reject(new BridgeError(`Invalid app id "${appId}".`));
    const target = this.find(appId);
    if (!target) return Promise.reject(new BridgeError(notOpen(appId)));
    if (!target.tools.some((t) => t.name === tool)) {
      const names = target.tools.map((t) => t.name).join(', ') || 'none';
      return Promise.reject(
        new BridgeError(
          `${appId} has no tool "${tool}". Its tools: ${names}. Call app_tools for their schemas.`,
        ),
      );
    }
    const id = randomUUID();
    const text = JSON.stringify({ type: 'call', id, tool, args });
    if (byteLength(text) > MAX_MESSAGE_BYTES) {
      return Promise.reject(new BridgeError('Arguments are larger than 1 MB. Send less data.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            `${appId} did not answer ${tool} within ${this.timeoutMs / 1000} s. Check the app is still open and try again.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { peerId: target.peer.id, resolve, reject, timer });
      try {
        target.peer.send(text);
      } catch {
        this.disconnect(target.peer.id);
      }
    });
  }

  /** Resolves once `appId` is registered, or with undefined after `ms`. */
  waitFor(appId: string, ms: number): Promise<OpenApp | undefined> {
    const now = this.find(appId);
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => {
        const found = this.find(appId);
        if (!found) return;
        clearTimeout(timer);
        this.off('change', done);
        resolve(found);
      };
      const timer = setTimeout(() => {
        this.off('change', done);
        resolve(undefined);
      }, ms);
      this.on('change', done);
    });
  }

  restoreLog(entries: LogEntry[]): void {
    this.log.splice(0, this.log.length, ...entries.slice(0, MAX_ACTIVITY));
    this.logId = this.log.reduce((max, entry) => Math.max(max, entry.id), 0);
  }

  clearLog(): void {
    this.log.length = 0;
    this.emit('activity');
    this.emit('change');
  }

  record(entry: Omit<LogEntry, 'id' | 'at'>): void {
    this.log.unshift({ id: ++this.logId, at: Date.now(), ...entry });
    this.log.length = Math.min(this.log.length, MAX_ACTIVITY);
    this.emit('activity');
    this.emit('change');
  }
}

/** A fresh peer id. */
export const peerId = (prefix: string) => `${prefix}:${randomUUID()}`;
