import type { Env } from '../types.js';
import { consume, newRateLimitState, type RateLimitState } from '../lib/rate-limit.js';

const MAX_PEERS = 32;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_MSGS_PER_SEC = 100;
const IDLE_EVICT_MS = 24 * 60 * 60 * 1000;

interface Peer {
  socket: WebSocket;
  uid: string;
  rateLimit: RateLimitState;
}

export class Room {
  private peers = new Map<WebSocket, Peer>();
  private lastActivity = Date.now();

  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {
    void this.state.blockConcurrencyWhile(async () => {
      const stored = (await this.state.storage.get<number>('lastActivity')) ?? Date.now();
      this.lastActivity = stored;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (Date.now() - this.lastActivity > IDLE_EVICT_MS) {
      await this.state.storage.deleteAll();
      this.lastActivity = Date.now();
    }

    if (this.peers.size >= MAX_PEERS) {
      return new Response('room full', { status: 503 });
    }

    const url = new URL(request.url);
    const uid = url.searchParams.get('uid') ?? 'anon';

    // Per the Cloudflare WebSocketPair spec, pair[0] is the client side
    // and pair[1] is the server side. Don't rely on Object.values order.
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const peer: Peer = {
      socket: server,
      uid,
      rateLimit: newRateLimitState(Date.now()),
    };
    this.peers.set(server, peer);
    this.broadcastPeers();

    server.addEventListener('message', (ev) => {
      this.lastActivity = Date.now();
      void this.state.storage.put('lastActivity', this.lastActivity);

      if (!consume(peer.rateLimit, Date.now(), MAX_MSGS_PER_SEC)) {
        server.send(JSON.stringify({ kind: 'error', error: 'rate_limited' }));
        return;
      }

      const data = ev.data;
      const size = typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength;
      if (size > MAX_MESSAGE_BYTES) {
        server.send(JSON.stringify({ kind: 'error', error: 'message_too_large' }));
        return;
      }

      let parsed: { kind?: string; data?: unknown };
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
      } catch {
        return;
      }
      if (parsed.kind !== 'msg') return;

      const out = JSON.stringify({ kind: 'msg', from: uid, data: parsed.data, at: Date.now() });
      this.broadcast(out, server);
    });

    server.addEventListener('close', () => {
      this.peers.delete(server);
      this.broadcastPeers();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(msg: string, except?: WebSocket): void {
    for (const peer of this.peers.values()) {
      if (peer.socket === except) continue;
      try {
        peer.socket.send(msg);
      } catch {
        // peer's gone, will clean up on close event
      }
    }
  }

  private broadcastPeers(): void {
    const peers = Array.from(this.peers.values()).map((p) => p.uid);
    const msg = JSON.stringify({ kind: 'peers', peers });
    for (const peer of this.peers.values()) {
      try {
        peer.socket.send(msg);
      } catch {
        // ignore
      }
    }
  }
}
