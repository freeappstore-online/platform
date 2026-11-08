import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageBytes, Room } from './room.js';

describe('messageBytes', () => {
  it('counts UTF-8 bytes for strings', () => {
    expect(messageBytes('abc')).toBe(3);
    // 3 bytes per CJK character: 4096 of them is ~12KB, over the 4KB cap.
    expect(messageBytes('漢'.repeat(4096))).toBe(12288);
  });

  it('counts ArrayBuffer bytes', () => {
    expect(messageBytes(new ArrayBuffer(10))).toBe(10);
  });
});

describe('Room durable object (#569)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const listeners: Array<(ev: { data: string }) => void> = [];
    class FakePair {
      0 = {};
      1 = {
        accept() {},
        send() {},
        addEventListener(type: string, fn: (ev: { data: string }) => void) {
          if (type === 'message') listeners.push(fn);
        },
      };
    }
    vi.stubGlobal('WebSocketPair', FakePair);
    // Node's Response rejects status 101; the DO only needs it to be returned.
    vi.stubGlobal(
      'Response',
      class {
        constructor(
          _b: unknown,
          public init: { status: number },
        ) {}
        get status() {
          return this.init.status;
        }
      },
    );
    const put = vi.fn(async () => {});
    const state = {
      blockConcurrencyWhile: async (f: () => Promise<void>) => f(),
      storage: { get: async () => undefined, put, deleteAll: async () => {} },
    };
    const room = new Room(state as never, {} as never);
    const connect = (uid: string) =>
      room.fetch(new Request(`https://x/?uid=${uid}&login=${uid}`)) as Promise<{ status: number }>;
    return { connect, put, listeners };
  }

  it('caps sockets per user, not per room', async () => {
    const { connect } = setup();
    for (let i = 0; i < 4; i++) expect((await connect('u1')).status).toBe(101);
    expect((await connect('u1')).status).toBe(429);
    expect((await connect('u2')).status).toBe(101);
  });

  it('persists lastActivity at most once a minute', async () => {
    const { connect, put, listeners } = setup();
    await connect('u1');
    const send = listeners[0] as (ev: { data: string }) => void;
    for (let i = 0; i < 20; i++) send({ data: '{"kind":"msg"}' });
    expect(put).toHaveBeenCalledTimes(1);
  });
});
