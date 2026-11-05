/** Bound bytes before OAuth or MCP parses JSON, including chunked/incorrect-length bodies. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;
export async function withBoundedBody(request: Request, next: (request: Request) => Promise<Response>): Promise<Response> {
  if (!request.body) return next(request);
  const tooLarge = () => new Response('Request too large; split file updates into smaller calls.', { status: 413 });
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    await request.body.cancel();
    return tooLarge();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) { await reader.cancel(); return tooLarge(); }
      chunks.push(value);
    }
  } catch {
    return new Response('Could not read request body.', { status: 400 });
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return next(new Request(request, { body, headers }));
}
