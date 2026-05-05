#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { initCommand } from './commands/init.js';
import { publishCommand } from './commands/publish.js';
import { logsCommand } from './commands/logs.js';
import { whoamiCommand } from './commands/whoami.js';

const program = new Command();

program
  .name('fas')
  .description('FreeAppStore CLI — sign in, scaffold, and publish free apps.')
  .version('0.0.0');

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
