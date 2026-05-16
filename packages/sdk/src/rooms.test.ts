import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth } from "./auth.js";
import { type Room, type RoomPeer, Rooms } from "./rooms.js";

/**
 * Minimal WebSocket stand-in. Tests poke at `created[i]` to drive open/
 * message/error/close events imperatively.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  url: string;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string | URL) {
    this.url = url.toString();
    created.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState !== FakeWebSocket.CLOSED) {
      this.readyState = FakeWebSocket.CLOSED;
      this.fire("close", {});
    }
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open", {});
  }
  triggerMessage(data: string): void {
    this.fire("message", { data });
  }
  triggerError(): void {
    this.fire("error", {});
  }
  triggerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", {});
  }

  private fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

let created: FakeWebSocket[] = [];

beforeEach(() => {
  created = [];
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).WebSocket;
  vi.useRealTimers();
});

function fakeAuth(token: string | null): Auth {
  return { token } as unknown as Auth;
}

function newRoom(token: string | null = "tok"): Room {
  const rooms = new Rooms("demo", "https://api.example", fakeAuth(token));
  return rooms.join("lobby");
}

describe("Room.connect — initial state", () => {
  it("starts in connecting state and creates a WebSocket immediately", () => {
    const room = newRoom();
    expect(created).toHaveLength(1);
    expect(room.state).toBe("connecting");
    expect(created[0]!.url).toMatch(/wss:\/\/api\.example\/v1\/apps\/demo\/rooms\/lobby/);
    expect(created[0]!.url).toContain("token=tok");
  });

  it("encodes appId and roomId in the URL path", () => {
    const rooms = new Rooms("app%name", "https://api.example", fakeAuth("tok"));
    rooms.join("room/with/slashes");
    expect(created[0]!.url).toContain("/v1/apps/app%25name/rooms/room%2Fwith%2Fslashes");
  });

  it("with no auth token, sets state to closed and does NOT open a socket", () => {
    const room = newRoom(null);
    expect(created).toHaveLength(0);
    expect(room.state).toBe("closed");
  });

  it("flips to open state when the socket opens", () => {
    const room = newRoom();
    created[0]!.triggerOpen();
    expect(room.state).toBe("open");
  });
});

describe("Room.onConnectionState", () => {
  it("fires immediately with current state on subscribe", () => {
    const room = newRoom();
    const seen: string[] = [];
    room.onConnectionState((s) => seen.push(s));
    expect(seen).toEqual(["connecting"]);
  });

  it("fires on every state transition", () => {
    const room = newRoom();
    const seen: string[] = [];
    room.onConnectionState((s) => seen.push(s));
    created[0]!.triggerOpen();
    expect(seen).toEqual(["connecting", "open"]);
  });

  it("does not fire when state is set to the same value", () => {
    const room = newRoom();
    const seen: string[] = [];
    room.onConnectionState((s) => seen.push(s));
    // Trigger open twice — should only see one open transition.
    created[0]!.triggerOpen();
    created[0]!.triggerOpen();
    expect(seen.filter((s) => s === "open")).toHaveLength(1);
  });

  it("returns an unsubscribe function", () => {
    const room = newRoom();
    const seen: string[] = [];
    const unsub = room.onConnectionState((s) => seen.push(s));
    unsub();
    created[0]!.triggerOpen(); // should NOT fire after unsub
    expect(seen).toEqual(["connecting"]);
  });
});

describe("Room.send", () => {
  it("serializes data to a kind:msg envelope when socket is open", () => {
    const room = newRoom();
    created[0]!.triggerOpen();
    room.send({ hello: "world" });
    expect(created[0]!.sent).toEqual([JSON.stringify({ kind: "msg", data: { hello: "world" } })]);
  });

  it("silently drops messages when socket is not yet open (regression: no throw)", () => {
    const room = newRoom();
    expect(() => room.send({ hello: "world" })).not.toThrow();
    expect(created[0]!.sent).toEqual([]);
  });

  it("silently drops messages after close", () => {
    const room = newRoom();
    created[0]!.triggerOpen();
    room.close();
    room.send({ hello: "world" });
    // After close, socket is null — no sent message.
    expect(created[0]!.sent).toEqual([]);
  });
});

describe("Room.onMessage", () => {
  it("receives kind:msg frames as RoomMessage", () => {
    const room = newRoom();
    created[0]!.triggerOpen();
    const messages: { from: RoomPeer; data: unknown; at: number }[] = [];
    room.onMessage((m) => messages.push(m));
    created[0]!.triggerMessage(
      JSON.stringify({
        kind: "msg",
        from: { uid: "gh:1", login: "alice" },
        data: { text: "hi" },
        at: 1700000000000,
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.from).toEqual({ uid: "gh:1", login: "alice" });
    expect(messages[0]!.data).toEqual({ text: "hi" });
  });

  it("ignores malformed JSON frames without throwing", () => {
    const room = newRoom();
    created[0]!.triggerOpen();
    const messages: unknown[] = [];
    room.onMessage((m) => messages.push(m));
    expect(() => created[0]!.triggerMessage("not-json{")).not.toThrow();
    expect(messages).toEqual([]);
  });

  it("ignores frames with unknown `kind`", () => {
    const room = newRoom();
    created[0]!.triggerOpen();
    const messages: unknown[] = [];
    room.onMessage((m) => messages.push(m));
    created[0]!.triggerMessage(JSON.stringify({ kind: "something-else", data: {} }));
    expect(messages).toEqual([]);
  });
});

describe("Room.onPeers", () => {
  it("fires immediately with empty peers list on subscribe", () => {
    const room = newRoom();
    const calls: RoomPeer[][] = [];
    room.onPeers((peers) => calls.push(peers));
    expect(calls).toEqual([[]]);
  });

  it("updates on kind:peers frame", () => {
    const room = newRoom();
    created[0]!.triggerOpen();
    const calls: RoomPeer[][] = [];
    room.onPeers((peers) => calls.push(peers));
    created[0]!.triggerMessage(
      JSON.stringify({
        kind: "peers",
        peers: [
          { uid: "gh:1", login: "alice" },
          { uid: "gh:2", login: "bob" },
        ],
      }),
    );
    expect(calls).toHaveLength(2); // initial + the broadcast
    expect(calls[1]).toEqual([
      { uid: "gh:1", login: "alice" },
      { uid: "gh:2", login: "bob" },
    ]);
  });
});

describe("Room.close", () => {
  it("stops reconnect, clears listeners, sets state to closed", () => {
    const room = newRoom();
    const stateSeen: string[] = [];
    const messages: unknown[] = [];
    room.onConnectionState((s) => stateSeen.push(s));
    room.onMessage((m) => messages.push(m));
    created[0]!.triggerOpen();

    room.close();

    expect(room.state).toBe("closed");
    // Sending should have no effect (socket cleared).
    room.send({ x: 1 });
    expect(created[0]!.sent.filter((s) => s.includes('"x":1'))).toEqual([]);
  });

  it("cancels a pending reconnect timer", () => {
    vi.useFakeTimers();
    const room = newRoom();
    created[0]!.triggerOpen();
    created[0]!.triggerClose(); // unexpected close → schedules reconnect
    expect(room.state).toBe("closed");

    room.close(); // user-initiated; should cancel reconnect

    vi.advanceTimersByTime(60_000); // jump past any backoff
    expect(created).toHaveLength(1); // no second connect
  });
});

describe("Room reconnect on unexpected close", () => {
  it("opens a new WebSocket after backoff", () => {
    vi.useFakeTimers();
    const room = newRoom();
    created[0]!.triggerOpen();
    expect(created).toHaveLength(1);

    created[0]!.triggerClose(); // unexpected — schedules reconnect
    expect(room.state).toBe("closed");

    // First reconnect attempt fires after RECONNECT_BASE_MS (1000ms) + jitter (up to 1000ms).
    vi.advanceTimersByTime(2100);
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(room.state).toBe("connecting");
  });

  it("opens succeed → state goes back to open + reconnect counter resets", () => {
    vi.useFakeTimers();
    const room = newRoom();
    created[0]!.triggerOpen();
    created[0]!.triggerClose();
    vi.advanceTimersByTime(2100);
    created[1]!.triggerOpen();
    expect(room.state).toBe("open");
  });
});

describe("Room error handling", () => {
  it("socket error → state goes to error", () => {
    const room = newRoom();
    created[0]!.triggerError();
    expect(room.state).toBe("error");
  });
});
