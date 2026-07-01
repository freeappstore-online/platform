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
export interface RoomPeer {
  uid: string;
  login: string;
}

export interface RoomMessage<T = unknown> {
  from: RoomPeer;
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
  private peerListeners = new Set<(peers: RoomPeer[]) => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private _peers: RoomPeer[] = [];
  private connectionState: ConnectionState = 'connecting';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;

  /** Enable to log all WebSocket traffic to console. */
  debug = false;

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

  /** Underlying WebSocket readyState (or -1 if no socket). */
  get socketState(): number {
    return this.socket?.readyState ?? -1;
  }

  /** Number of registered message listeners. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Current peer list (read-only snapshot). */
  get peers(): RoomPeer[] {
    return this._peers;
  }

  /** Number of reconnect attempts since last successful connection. */
  get reconnectAttempts(): number {
    return this.reconnectAttempt;
  }

  /** Whether a reconnect is currently pending. */
  get isReconnecting(): boolean {
    return this.reconnectTimer !== null;
  }

  send<T>(data: T): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.debug) console.warn('[rooms] send dropped — socket not open', this.connectionState);
      return;
    }
    const frame = JSON.stringify({ kind: 'msg', data });
    if (this.debug) console.log('[rooms] →', frame);
    this.socket.send(frame);
  }

  onMessage<T = unknown>(listener: (msg: RoomMessage<T>) => void): Unsubscribe {
    this.listeners.add(listener as (msg: RoomMessage) => void);
    return () => this.listeners.delete(listener as (msg: RoomMessage) => void);
  }

  onPeers(listener: (peers: RoomPeer[]) => void): Unsubscribe {
    this.peerListeners.add(listener);
    listener(this._peers);
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
    void this.connectAsync();
  }

  private async connectAsync(): Promise<void> {
    const token = this.auth.token;
    if (!token) {
      // Auth state may have changed (sign-out). Stop trying.
      this.setState('closed');
      return;
    }
    this.setState('connecting');

    // Exchange the account session token (header auth, off the URL) for a
    // short-lived room ticket, then put only the ticket in the WS URL. This
    // keeps the account-wide token out of edge/proxy access logs.
    let ticket: string;
    try {
      const res = await fetch(
        new URL(
          `/v1/apps/${encodeURIComponent(this.appId)}/rooms/${encodeURIComponent(this.roomId)}/ticket`,
          this.apiBase,
        ),
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`ticket request failed (${res.status})`);
      ticket = ((await res.json()) as { ticket: string }).ticket;
    } catch (e) {
      if (this.debug) console.warn('[rooms] ticket fetch failed', e);
      this.setState('error');
      this.scheduleReconnect();
      return;
    }

    // The room may have been closed while the ticket request was in flight.
    if (this.explicitlyClosed) return;

    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/rooms/${encodeURIComponent(this.roomId)}`,
      this.apiBase,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.setState('open');
      if (this.debug) console.log(`[rooms] connected to ${this.roomId}`);
    });

    socket.addEventListener('message', (ev) => {
      if (this.debug) console.log('[rooms] ←', ev.data);
      try {
        const parsed = JSON.parse(ev.data as string) as
          | { kind: 'msg'; from: RoomPeer; data: unknown; at: number }
          | { kind: 'peers'; peers: RoomPeer[] };
        if (parsed.kind === 'msg') {
          if (this.debug)
            console.log(`[rooms] msg from ${parsed.from.login}, ${this.listeners.size} listeners`);
          for (const l of this.listeners) {
            l({ from: parsed.from, data: parsed.data, at: parsed.at });
          }
        } else if (parsed.kind === 'peers') {
          this._peers = parsed.peers;
          if (this.debug) console.log(`[rooms] peers: ${this._peers.length}`);
          for (const l of this.peerListeners) l(this._peers);
        }
      } catch (e) {
        if (this.debug) console.warn('[rooms] malformed frame', ev.data, e);
      }
    });

    socket.addEventListener('close', (ev) => {
      if (this.debug) console.log(`[rooms] closed (code=${ev.code} reason=${ev.reason || 'none'})`);
      if (this.socket === socket) this.socket = null;
      if (this.explicitlyClosed) return;
      this.setState('closed');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (this.debug) console.warn(`[rooms] socket error on ${this.roomId}`);
      this.setState('error');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    // Exponential backoff capped at 30s, with up to 1s of jitter so a
    // backend hiccup doesn't produce a thundering herd of reconnects.
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    const jitter = Math.random() * 1000;
    this.reconnectAttempt++;
    if (this.debug)
      console.log(
        `[rooms] reconnect #${this.reconnectAttempt} in ${Math.round(backoff + jitter)}ms`,
      );
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
