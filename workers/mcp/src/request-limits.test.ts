import { describe, expect, it, vi } from 'vitest';
import { MAX_REQUEST_BODY_BYTES, withBoundedBody } from './request-limits.js';
const request = (body: BodyInit, headers?: HeadersInit) => new Request('https://mcp.test/mcp', { method: 'POST', body, headers });
describe('request parsing bounds', () => {
  it('passes a normal file-update payload and auth headers without changing bytes', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', params: { files: [{ path: 'web/src/App.tsx', content: 'content' }] } });
    const next = vi.fn(async (req: Request) => { expect(req.headers.get('authorization')).toBe('Bearer test'); expect(await req.text()).toBe(body); return new Response('ok'); });
    expect((await withBoundedBody(request(body, { authorization: 'Bearer test' }), next)).status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('rejects an oversized declared length before forwarding', async () => {
    const next = vi.fn();
    expect((await withBoundedBody(request('small', { 'content-length': `${MAX_REQUEST_BODY_BYTES + 1}` }), next)).status).toBe(413);
    expect(next).not.toHaveBeenCalled();
  });
  it('bounds actual chunked bytes even when content-length lies', async () => {
    const cancel = vi.fn(); const chunk = new Uint8Array(MAX_REQUEST_BODY_BYTES / 2);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.enqueue(chunk); }, cancel });
    const req = new Request('https://mcp.test/mcp', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-length': '1' } } as RequestInit);
    const next = vi.fn();
    expect((await withBoundedBody(req, next)).status).toBe(413);
    expect(next).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalled();
  });
  it('allows exactly the limit and keeps read-only requests unconsumed', async () => {
    const next = async (req: Request) => new Response(`${(await req.arrayBuffer()).byteLength}`);
    expect(await (await withBoundedBody(request(new Uint8Array(MAX_REQUEST_BODY_BYTES)), next)).text()).toBe(`${MAX_REQUEST_BODY_BYTES}`);
    const get = new Request('https://mcp.test/mcp'); const passthrough = vi.fn(async () => new Response('ok'));
    await withBoundedBody(get, passthrough); expect(passthrough).toHaveBeenCalledWith(get);
  });
});

it('enforces the SDK element budget before a file-update tool handler runs', async () => {
  const [{ McpServer }, { Client }, { InMemoryTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'), import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/inMemory.js'), import('zod'),
  ]);
  const { MAX_TOOL_INPUT_ELEMENTS } = await import('./request-limits.js');
  const server = new McpServer({ name: 'limit-test', version: '1.0.0' }, { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS });
  const run = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  server.tool('files', { files: z.array(z.object({ path: z.string(), content: z.string() })) }, run);
  const client = new Client({ name: 'limit-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    expect((await client.callTool({ name: 'files', arguments: { files: [{ path: 'app.tsx', content: 'ok' }] } })).isError).not.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: 'files', arguments: { files: Array.from({ length: MAX_TOOL_INPUT_ELEMENTS }, () => ({ path: 'a', content: '' })) } })).isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  } finally { await client.close(); await server.close(); }
});
