import { Command } from 'commander';
import { readConfig } from '../lib/config.js';

export const logsCommand = new Command('logs')
  .description('Tail recent logs for one of your apps.')
  .argument('<app-id>')
  .option('-n, --lines <n>', 'Number of lines to fetch', '100')
  .action(async (appId: string, opts: { lines: string }) => {
    const config = await readConfig();
    if (!config.github?.accessToken) {
      throw new Error('Not signed in. Run: fas login');
    }
    const res = await fetch(
      `${config.apiBase}/v1/apps/${encodeURIComponent(appId)}/logs?lines=${encodeURIComponent(opts.lines)}`,
      { headers: { Authorization: `Bearer ${config.github.accessToken}` } },
    );
    if (!res.ok) {
      throw new Error(`Logs request failed: ${res.status}`);
    }
    const text = await res.text();
    process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
  });
