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

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fas: ${msg}\n`);
  process.exit(1);
});
