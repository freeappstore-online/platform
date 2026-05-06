import { Command } from 'commander';
import { readConfig } from '../lib/config.js';

interface ListedApp {
  id: string;
  ownerLogin: string;
  createdAt: number;
  category: string | null;
  type: string | null;
  oneliner: string | null;
  repo: string | null;
  demo: string | null;
  appUrl: string;
  repoUrl: string;
}

const isTTY = Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] !== '1';
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[22m` : s);

export const listCommand = new Command('list')
  .alias('ls')
  .description('List apps you have published to FreeAppStore.')
  .option('--json', 'Output JSON instead of a table.')
  .action(async (opts: { json?: boolean }) => {
    const config = await readConfig();
    if (!config.session?.token) {
      process.stdout.write('\n⚠  Not signed in. Run: fas login\n');
      process.exit(1);
    }

    const res = await fetch(`${config.apiBase}/v1/apps/mine`, {
      headers: { Authorization: `Bearer ${config.session.token}` },
    });
    if (res.status === 401) {
      process.stdout.write('\n⚠  Session expired. Run: fas login\n');
      process.exit(1);
    }
    if (!res.ok) {
      const body = await res.text();
      process.stdout.write(`\n✗ Failed to fetch apps (${res.status}): ${body}\n`);
      process.exit(1);
    }

    const { apps } = (await res.json()) as { apps: ListedApp[] };

    if (opts.json) {
      process.stdout.write(JSON.stringify(apps, null, 2) + '\n');
      return;
    }

    if (apps.length === 0) {
      process.stdout.write('\nNo apps yet. Run `fas init` to start one.\n');
      return;
    }

    process.stdout.write('\n');
    for (const a of apps) {
      process.stdout.write(`${bold(a.id.padEnd(20))} ${dim(a.category ?? '—')}\n`);
      if (a.oneliner) process.stdout.write(`  ${a.oneliner}\n`);
      process.stdout.write(`  ${dim('live:')} ${a.appUrl}\n`);
      process.stdout.write(`  ${dim('repo:')} ${a.repoUrl}\n`);
      process.stdout.write('\n');
    }
    process.stdout.write(dim(`${apps.length} app${apps.length === 1 ? '' : 's'}\n`));
  });
