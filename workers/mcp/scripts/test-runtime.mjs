import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const portProbe = createServer();
await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const state = await mkdtemp(join(tmpdir(), 'fas-mcp-runtime-'));
const worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'test/runtime/wrangler.toml', '--port', `${port}`, '--persist-to', state], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
let exited = false;
worker.on('exit', () => { exited = true; });
for (const output of [worker.stdout, worker.stderr]) output.on('data', (chunk) => { log = (log + chunk).slice(-8000); });
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const client = new Client({ name: 'fas-runtime-test', version: '1.0.0' });
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    if (exited) throw new Error(`Worker exited before ready:\n${log}`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); break; }
    catch { if (Date.now() >= deadline) throw new Error(`Worker startup timed out:\n${log}`); await new Promise((r) => setTimeout(r, 100)); }
  }
  await client.connect(new StreamableHTTPClientTransport(url));
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === 'sdk_reference'));
  const guide = await client.callTool({ name: 'sdk_reference', arguments: { feature: 'forms' } });
  assert(!guide.isError && JSON.stringify(guide).includes('EditItemButton'));
  const refused = await client.callTool({ name: 'sdk_reference', arguments: { feature: 'forms', excessive: Array(10_001).fill(0) } });
  assert.equal(refused.isError, true, 'SDK must reject excess input elements');
  const oversized = await fetch(url, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  console.log('Real Worker MCP initialize, tool discovery, guide call, element limit and body limit passed.');
} finally {
  await client.close().catch(() => {});
  worker.kill('SIGTERM');
  await new Promise((resolve) => { if (exited) resolve(); else worker.once('exit', resolve); });
  await rm(state, { recursive: true, force: true });
}
