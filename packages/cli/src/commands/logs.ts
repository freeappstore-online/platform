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
      child.on('exit', (code, signal) => {
        const err = ghExitError(code, signal);
        if (err) rejectFn(err);
        else resolveFn();
      });
    });
  });

/**
 * Success only on exit code 0. A process killed by a signal exits with code
 * null, which used to count as success (#283).
 */
export function ghExitError(code: number | null, signal: NodeJS.Signals | null): Error | null {
  if (code === 0) return null;
  return new Error(
    code === null ? `gh was stopped by ${signal ?? 'a signal'}` : `gh exited with code ${code}`,
  );
}
