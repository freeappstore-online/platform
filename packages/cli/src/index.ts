#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { initCommand } from './commands/init.js';
import { publishCommand } from './commands/publish.js';
import { logsCommand } from './commands/logs.js';
import { whoamiCommand } from './commands/whoami.js';
import { doctorCommand } from './commands/doctor.js';
import { checkCommand } from './commands/check.js';
import { listCommand } from './commands/list.js';

// Read version from the package's own package.json so `fas --version` always
// matches the installed package. dist/index.js sits one level under the
// package root (where package.json lives).
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  version: string;
};

const program = new Command();

program
  .name('fas')
  .description('FreeAppStore CLI — sign in, scaffold, and publish free apps.')
  .version(pkg.version);

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(initCommand);
program.addCommand(publishCommand);
program.addCommand(logsCommand);
program.addCommand(doctorCommand);
program.addCommand(checkCommand);
program.addCommand(listCommand);

// `fas` with no subcommand → launch the TUI when stdout is a TTY.
// Subcommands keep their normal one-shot behavior, scriptable for CI / agents.
async function main(): Promise<void> {
  if (process.argv.length === 2) {
    if (!process.stdout.isTTY) {
      // Piped output (CI, redirects). Show help instead of TUI.
      program.outputHelp();
      return;
    }
    const { startTui } = await import('./tui/start.js');
    await startTui();
    return;
  }
  await program.parseAsync();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fas: ${msg}\n`);
  process.exit(1);
});
