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

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

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

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class Room {
  private socket: WebSocket | null = null;
  private listeners = new Set<(msg: RoomMessage) => void>();
  private peerListeners = new Set<(peers: string[]) => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private peers: string[] = [];
  private connectionState: ConnectionState = 'connecting';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
    private readonly roomId: string,
  ) {
    this.connect();
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this.connectionState;
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

  onConnectionState(listener: (state: ConnectionState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    listener(this.connectionState);
    return () => this.stateListeners.delete(listener);
  }

  /** Permanently close the room. Stops any pending reconnect. */
  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
    this.listeners.clear();
    this.peerListeners.clear();
    this.stateListeners.clear();
  }

  private connect(): void {
    const token = this.auth.token;
    if (!token) {
      // Auth state may have changed (sign-out). Stop trying.
      this.setState('closed');
      return;
    }
    this.setState('connecting');

    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/rooms/${encodeURIComponent(this.roomId)}`,
      this.apiBase,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.setState('open');
    });

    socket.addEventListener('message', (ev) => {
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
        // Ignore malformed frames — server should never send them; if it
        // does, dropping is the right move and an error frame would have
        // come through `kind: 'error'` instead.
      }
    });

    socket.addEventListener('close', () => {
      // Only one of close/error fires the reconnect; we use close because
      // it always fires, even after an error, and is the canonical signal.
      if (this.socket === socket) this.socket = null;
      if (this.explicitlyClosed) return;
      this.setState('closed');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // We let the close handler do the actual reconnect logic. error is
      // informational and may or may not be followed by close (it always is
      // in browsers per spec).
      this.setState('error');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    // Exponential backoff capped at 30s, with up to 1s of jitter so a
    // backend hiccup doesn't produce a thundering herd of reconnects.
    const backoff = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    const jitter = Math.random() * 1000;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed) return;
      this.connect();
    }, backoff + jitter);
  }

  private setState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const l of this.stateListeners) l(state);
  }
}
