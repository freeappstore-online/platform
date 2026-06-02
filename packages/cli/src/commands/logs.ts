import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { assertValidAppId } from '../lib/app-id.js';

export const logsCommand = new Command('logs')
  .description('Show recent GitHub Actions workflow runs for an app.')
  .argument('<app-id>', 'Short app id (e.g. "calculator")')
  .action(async (appId: string) => {
    assertValidAppId(appId);

    const repo = `freeappstore-online/${appId}`;
    process.stdout.write(`Fetching workflow runs for ${repo}...\n`);

    await new Promise<void>((resolveFn, rejectFn) => {
      const child = spawn('gh', ['run', 'list', '--repo', repo, '--limit', '10'], {
        stdio: 'inherit',
      });
      child.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          rejectFn(new Error('gh CLI is not installed. Install it: https://cli.github.com'));
        } else {
          rejectFn(err);
        }
      });
      child.on('exit', (code) => {
        if (code === 0 || code === null) resolveFn();
        else rejectFn(new Error(`gh exited with code ${code}`));
      });
    });
  });
