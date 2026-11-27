// The bundled `fas` CLI (@freeappstore/cli), run by the Publish page (#800) as
//   ELECTRON_RUN_AS_NODE=1 <FreeAppStore binary> <…>/dist/cli/fas.mjs <fas arguments>
// The CLI reads and writes its own sign-in (~/.fas/config.json); the desktop never sees the session token.
import { readConfig } from '@freeappstore/cli/dist/lib/config.js';

// Commander treats an Electron binary as an app (argv[1] is a user argument) unless defaultApp is set; in node
// mode argv is node's: [binary, script, ...arguments].
Object.assign(process, { defaultApp: true });

if (process.argv[2] === '--my-apps') {
  // `fas list --json` without its GitHub commit history (one anonymous GitHub API call per app).
  const config = await readConfig();
  if (!config.session?.token) {
    process.stdout.write('Not signed in.\n');
    process.exit(2);
  }
  const res = await fetch(`${config.apiBase}/v1/apps/mine`, {
    headers: { Authorization: `Bearer ${config.session.token}` },
  });
  if (res.status === 401) {
    process.stdout.write('Your sign-in expired. Sign in again.\n');
    process.exit(2);
  }
  if (!res.ok) {
    process.stdout.write(`Could not load your apps (${res.status}).\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(await res.json())}\n`);
} else {
  await import('@freeappstore/cli/dist/index.js');
}
