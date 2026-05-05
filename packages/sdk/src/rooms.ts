import type { Auth } from './auth.js';
import type { Unsubscribe } from './types.js';

/**
 * Light realtime room — Durable-Object-backed WebSocket fan-out.
 *
 * Use cases: cursor presence, low-state multiplayer (Slither-style), chat-light.
 * Not a multiplayer game server. Messages are not persisted.
 *
 * Limits (enforced server-side):
 * - max 32 concurrent peers per room
 * - max 100 messages/sec per peer
 * - max 4KB per message
 * - max 64 active rooms per app (LRU evicts the oldest)
 * - rooms idle for 24h are auto-evicted
 */
export interface RoomMessage<T = unknown> {
  from: string;
  data: T;
  at: number;
}

export class Rooms {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  join(roomId: string): Room {
    return new Room(this.appId, this.apiBase, this.auth, roomId);
  }
}

export class Room {
  private socket: WebSocket | null = null;
  private listeners = new Set<(msg: RoomMessage) => void>();
  private peerListeners = new Set<(peers: string[]) => void>();
  private peers: string[] = [];

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
    private readonly roomId: string,
  ) {
    this.connect();
  }

  send<T>(data: T): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ kind: 'msg', data }));
  }

  onMessage<T = unknown>(listener: (msg: RoomMessage<T>) => void): Unsubscribe {
    this.listeners.add(listener as (msg: RoomMessage) => void);
    return () => this.listeners.delete(listener as (msg: RoomMessage) => void);
  }

  onPeers(listener: (peers: string[]) => void): Unsubscribe {
    this.peerListeners.add(listener);
    listener(this.peers);
    return () => this.peerListeners.delete(listener);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
    this.peerListeners.clear();
  }

  private connect(): void {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/rooms/${encodeURIComponent(this.roomId)}`,
      this.apiBase,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    this.socket = new WebSocket(url.toString());

    this.socket.addEventListener('message', (ev) => {
      try {
        const parsed = JSON.parse(ev.data as string) as
          | { kind: 'msg'; from: string; data: unknown; at: number }
          | { kind: 'peers'; peers: string[] };
        if (parsed.kind === 'msg') {
          for (const l of this.listeners) {
            l({ from: parsed.from, data: parsed.data, at: parsed.at });
          }
        } else if (parsed.kind === 'peers') {
          this.peers = parsed.peers;
          for (const l of this.peerListeners) l(this.peers);
        }
      } catch {
        // ignore malformed frames
      }
    });
  }
}
