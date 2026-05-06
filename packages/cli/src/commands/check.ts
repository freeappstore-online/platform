import { Command } from 'commander';
import { runChecks, type CheckResult } from '@freeappstore/compliance';

const isTTY = Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] !== '1';
const c = (open: string) => (s: string) => (isTTY ? `\x1b[${open}m${s}\x1b[39m` : s);
const green = c('32');
const yellow = c('33');
const red = c('31');
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[22m` : s);

const ICON: Record<CheckResult['status'], string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
};

const COLOR: Record<CheckResult['status'], (s: string) => string> = {
  pass: green,
  warn: yellow,
  fail: red,
};

export const checkCommand = new Command('check')
  .description('Run FreeAppStore compliance checks against the current directory.')
  .option('--dir <path>', 'Directory to check', process.cwd())
  .action(async (opts: { dir: string }) => {
    const results = await runChecks(opts.dir);

    let failed = 0;
    let warned = 0;
    for (const r of results) {
      const icon = COLOR[r.status](ICON[r.status]);
      process.stdout.write(`${icon}  ${bold(r.name.padEnd(28))} ${dim(r.detail)}\n`);
      if (r.suggestions && r.suggestions.length > 0 && r.status !== 'pass') {
        for (const s of r.suggestions) {
          process.stdout.write(`     ${dim('→')} ${dim(s)}\n`);
        }
      }
      if (r.status === 'fail') failed++;
      if (r.status === 'warn') warned++;
    }

    process.stdout.write('\n');
    if (failed > 0) {
      process.stdout.write(red(`✗ ${failed} failed`));
    } else {
      process.stdout.write(green(`✓ all hard checks passed`));
    }
    if (warned > 0) {
      process.stdout.write(yellow(`, ${warned} warning${warned === 1 ? '' : 's'}`));
    }
    process.stdout.write('\n');

    if (failed > 0) process.exit(1);
  });
