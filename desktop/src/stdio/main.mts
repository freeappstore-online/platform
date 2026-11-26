// stdio MCP entry point (#815), run by AI clients as
//   ELECTRON_RUN_AS_NODE=1 <FreeAppStore binary> <…>/dist/stdio/main.mjs
// See proxy.mts. If the app isn't running, it starts it in the background (`--hidden`; the app's
// single-instance lock keeps it to one) and waits for its server.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createProxy, target } from './proxy.mjs';

const START_WAIT_MS = 20_000;
const { url, readToken } = target();

const up = () =>
  fetch(url, { method: 'POST' }).then(
    () => true,
    () => false,
  );

let starting: Promise<boolean> | null = null;
function ensureApp(): Promise<boolean> {
  starting ??= (async () => {
    if (await up()) return true;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // Dev builds run the electron binary on an app directory; a packaged binary is the app.
    const args = [...(env.FAS_DESKTOP_APP_PATH ? [env.FAS_DESKTOP_APP_PATH] : []), '--hidden'];
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', env }).unref();
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await up()) return true;
    }
    return false;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

const handle = createProxy({
  url,
  readToken,
  ensureApp,
  write: (line) => process.stdout.write(`${line}\n`),
});

const inFlight = new Set<Promise<void>>();
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const done = handle(line).finally(() => inFlight.delete(done));
    inFlight.add(done);
  })
  .on('close', async () => {
    await Promise.allSettled(inFlight);
    process.exit(0);
  });
