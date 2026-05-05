import { Command } from 'commander';
import { spawn } from 'node:child_process';

export const logsCommand = new Command('logs')
  .description("Tail live logs for one of your apps' Cloudflare Pages project.")
  .argument('<app-id>', 'Short app id (e.g. "calculator")')
  .option(
    '--cf-project <name>',
    'Override the Cloudflare Pages project name. Default: free<app-id>app, but several existing projects use legacy names (e.g. freemusic, freepuzzle, freeappstore).',
  )
  .action(async (appId: string, opts: { cfProject?: string }) => {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(appId)) {
      throw new Error('app-id must be lowercase letters, digits, or hyphens (2-31 chars).');
    }
    const cfProject = opts.cfProject ?? `free${appId}app`;

    process.stdout.write(`Tailing logs for ${cfProject} (Ctrl+C to stop)...\n`);

    await new Promise<void>((resolveFn, rejectFn) => {
      const child = spawn('wrangler', ['pages', 'deployment', 'tail', '--project-name', cfProject], {
        stdio: 'inherit',
      });
      child.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          rejectFn(new Error('wrangler is not installed. Install it: npm i -g wrangler'));
        } else {
          rejectFn(err);
        }
      });
      child.on('exit', (code) => {
        if (code === 0 || code === null) resolveFn();
        else rejectFn(new Error(`wrangler exited with code ${code}`));
      });
    });
  });
