import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppTool, BRIDGE_URL, type DesktopBridgeChannel, exposeTools } from './bridge.js';

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  /** Deliver a host message and wait for the reply. */
  async call(message: object) {
    const before = this.sent.length;
    this.onmessage?.({ data: JSON.stringify(message) });
    await vi.waitFor(() => expect(this.sent.length).toBeGreaterThan(before));
    return JSON.parse(this.sent.at(-1)!);
  }
}

const last = () => FakeSocket.all.at(-1)!;

const add: AppTool = {
  name: 'add',
  description: 'Add two numbers.',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
  handler: ({ a, b }) => a + b,
};
const fail: AppTool = {
  name: 'fail',
  description: 'Always fails.',
  inputSchema: { type: 'object' },
  handler: async () => {
    throw new Error('Sheet "Q4" does not exist.');
  },
};

function setHost(hostname: string) {
  vi.stubGlobal('location', { hostname });
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('document', { title: 'Spreadsheet' });
  setHost('spreadsheet.freeappstore.online');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('exposeTools over WebSocket', () => {
  it('connects to the local bridge and registers the app id, title and tool schemas', () => {
    const statuses: string[] = [];
    exposeTools({ tools: [add], onStatus: (s) => statuses.push(s) });
    expect(last().url).toBe(BRIDGE_URL);
    expect(BRIDGE_URL).toBe('ws://127.0.0.1:47821/bridge');
    last().open();
    expect(JSON.parse(last().sent[0]!)).toEqual({
      type: 'register',
      appId: 'spreadsheet',
      title: 'Spreadsheet',
      tools: [{ name: 'add', description: 'Add two numbers.', inputSchema: add.inputSchema }],
    });
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('runs calls and returns results, handler errors and unknown tools', async () => {
    exposeTools({ tools: [add, fail] });
    last().open();
    expect(await last().call({ type: 'call', id: '1', tool: 'add', args: { a: 2, b: 3 } })).toEqual(
      { type: 'result', id: '1', ok: true, result: 5 },
    );
    expect(await last().call({ type: 'call', id: '2', tool: 'fail', args: {} })).toEqual({
      type: 'result',
      id: '2',
      ok: false,
      error: 'Sheet "Q4" does not exist.',
    });
    expect(await last().call({ type: 'call', id: '3', tool: 'nope' })).toMatchObject({
      ok: false,
      error: 'Unknown tool "nope". Tools: add, fail.',
    });
  });

  it('refuses results over 1 MB with an actionable error', async () => {
    const big: AppTool = { ...add, name: 'big', handler: () => 'x'.repeat(1024 * 1024) };
    exposeTools({ tools: [big] });
    last().open();
    const reply = await last().call({ type: 'call', id: '1', tool: 'big' });
    expect(reply).toMatchObject({ ok: false });
    expect(reply.error).toContain('more than 1 MB');
  });

  it('ignores oversized and malformed host messages', async () => {
    exposeTools({ tools: [add] });
    last().open();
    last().onmessage?.({ data: 'not json' });
    last().onmessage?.({ data: JSON.stringify({ type: 'call', id: 'x'.repeat(1024 * 1024) }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(last().sent).toHaveLength(1);
  });

  it('does not connect while disabled, and connects/disconnects with setEnabled', () => {
    const bridge = exposeTools({ tools: [add], enabled: false });
    expect(FakeSocket.all).toHaveLength(0);
    expect(bridge.status).toBe('off');
    bridge.setEnabled(true);
    expect(FakeSocket.all).toHaveLength(1);
    last().open();
    expect(bridge.status).toBe('connected');
    bridge.setEnabled(false);
    expect(last().closed).toBe(true);
    expect(bridge.status).toBe('off');
  });

  it('reconnects quietly with backoff while enabled', () => {
    vi.useFakeTimers();
    const bridge = exposeTools({ tools: [add] });
    last().onclose?.({ code: 1006 });
    expect(bridge.status).toBe('connecting');
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    bridge.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('stops when the desktop app rejects the app (policy violation)', () => {
    vi.useFakeTimers();
    const bridge = exposeTools({ tools: [add] });
    last().onclose?.({ code: 1008 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(bridge.status).toBe('rejected');
  });

  it('needs an explicit appId off freeappstore.online', () => {
    setHost('localhost');
    expect(() => exposeTools({ tools: [add] })).toThrow(/pass appId/);
    exposeTools({ tools: [add], appId: 'spreadsheet', url: 'ws://127.0.0.1:1/bridge' });
    expect(last().url).toBe('ws://127.0.0.1:1/bridge');
    last().open();
    expect(JSON.parse(last().sent[0]!).appId).toBe('spreadsheet');
  });
});

describe('exposeTools inside the desktop app (IPC)', () => {
  function channel() {
    const sent: string[] = [];
    let listener: (m: string) => void = () => {};
    const ipc: DesktopBridgeChannel = {
      send: (m) => sent.push(m),
      onMessage: (l) => {
        listener = l;
      },
    };
    vi.stubGlobal('fasDesktopBridge', ipc);
    return { sent, deliver: (m: object) => listener(JSON.stringify(m)) };
  }

  it('uses the preload channel instead of the network', async () => {
    const ipc = channel();
    setHost('localhost');
    const bridge = exposeTools({ tools: [add] });
    expect(FakeSocket.all).toHaveLength(0);
    expect(bridge.status).toBe('connected');
    expect(JSON.parse(ipc.sent[0]!)).toMatchObject({ type: 'register', tools: [{ name: 'add' }] });
    ipc.deliver({ type: 'call', id: '7', tool: 'add', args: { a: 1, b: 1 } });
    await vi.waitFor(() => expect(ipc.sent).toHaveLength(2));
    expect(JSON.parse(ipc.sent[1]!)).toEqual({ type: 'result', id: '7', ok: true, result: 2 });
  });

  it('unregisters when disabled and ignores calls until re-enabled', async () => {
    const ipc = channel();
    const bridge = exposeTools({ tools: [add] });
    bridge.setEnabled(false);
    expect(JSON.parse(ipc.sent[1]!)).toEqual({ type: 'unregister' });
    ipc.deliver({ type: 'call', id: '1', tool: 'add', args: { a: 1, b: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(ipc.sent).toHaveLength(2);
    bridge.setEnabled(true);
    expect(JSON.parse(ipc.sent[2]!).type).toBe('register');
    bridge.close();
    expect(JSON.parse(ipc.sent[3]!)).toEqual({ type: 'unregister' });
  });
});
