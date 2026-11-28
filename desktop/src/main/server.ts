import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer } from 'ws';
import { type Hub, MAX_MESSAGE_BYTES, type Peer, peerId } from './hub.js';
import { createMcpServer, type McpDeps } from './mcp.js';
import { APP_ID, bridgeOriginAppId, HOST, isAuthorized } from './security.js';

export interface ServerOptions extends McpDeps {
  hub: Hub;
  port: number;
  /** Read on every request, so regenerating takes effect immediately. */
  token(): string;
  /** Dev builds also accept bridge connections from http://localhost:* and http://127.0.0.1:*. */
  dev: boolean;
}

const POLICY_VIOLATION = 1008;

function json(
  res: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Past the cap, keep draining (so the 413 reaches the client) but stop buffering.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_MESSAGE_BYTES) chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(size > MAX_MESSAGE_BYTES ? null : Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, options: ServerOptions) {
  // Browsers always send Origin on cross-origin requests; MCP clients don't. Refusing it keeps
  // web pages (including DNS-rebinding ones) from driving the server.
  if (req.headers.origin !== undefined) {
    return json(res, 403, { error: 'Requests from web pages are not allowed.' });
  }
  if (!isAuthorized(req.headers.authorization, options.token())) {
    return json(
      res,
      401,
      { error: 'Missing or wrong bearer token. Copy the setup command from the FreeAppStore app.' },
      { 'www-authenticate': 'Bearer' },
    );
  }
  if (req.method !== 'POST')
    return json(res, 405, { error: 'Method not allowed.' }, { allow: 'POST' });
  const raw = await readBody(req);
  if (raw === null) return json(res, 413, { error: 'Request larger than 1 MB.' });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: 'Request body is not JSON.' });
  }
  // Stateless: a fresh server and transport per request; the hub holds all state.
  const server = createMcpServer(options);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function refuseUpgrade(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Starts the loopback server: MCP at /mcp, the app bridge WebSocket at /bridge. */
export function startServer(options: ServerOptions): Promise<Server> {
  const { hub, dev } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  const server = createServer((req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return json(res, 400, { error: 'Invalid request URL.' });
    }
    if (path !== '/mcp') return json(res, 404, { error: 'Not found.' });
    handleMcp(req, res, options).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'Internal error.' });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return refuseUpgrade(socket, '400 Bad Request');
    }
    if (path !== '/bridge') return refuseUpgrade(socket, '404 Not Found');
    const allowed = bridgeOriginAppId(req.headers.origin, dev);
    if (!allowed) return refuseUpgrade(socket, '403 Forbidden');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const peer: Peer = {
        id: peerId('ws'),
        source: 'browser',
        send: (text) => ws.send(text),
        reject: (reason) => ws.close(POLICY_VIOLATION, reason.slice(0, 120)),
        resolveAppId(claimed) {
          if (typeof claimed !== 'string' || !APP_ID.test(claimed)) {
            return { error: 'Invalid app id.' };
          }
          if (allowed !== '*' && claimed !== allowed) {
            return { error: `This page is ${allowed}, not ${claimed}.` };
          }
          return { appId: claimed };
        },
      };
      ws.on('message', (data, isBinary) => {
        if (isBinary) return peer.reject('Binary messages are not supported.');
        hub.receive(peer, data.toString());
      });
      ws.on('close', () => hub.disconnect(peer.id));
      ws.on('error', () => hub.disconnect(peer.id));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, HOST, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
