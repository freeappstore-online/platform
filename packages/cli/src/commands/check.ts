import { type CheckResult, runChecks } from '@freeappstore/compliance';
import { Command } from 'commander';
import { bold, dim, green, red, yellow } from '../lib/style.js';

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

export interface CheckSummary {
  failed: number;
  warned: number;
  passed: number;
}

/**
 * Print compliance results in the standard format. Reused by `fas check`
 * and by `fas publish`'s pre-flight gate so output stays identical.
 */
export function renderCheckResults(results: CheckResult[]): CheckSummary {
  let failed = 0;
  let warned = 0;
  let passed = 0;
  for (const r of results) {
    const icon = COLOR[r.status](ICON[r.status]);
    process.stdout.write(`${icon}  ${bold(r.name.padEnd(28))} ${dim(r.detail)}\n`);
    if (r.suggestions && r.suggestions.length > 0 && r.status !== 'pass') {
      for (const s of r.suggestions) {
        process.stdout.write(`     ${dim('→')} ${dim(s)}\n`);
      }
    }
    if (r.status === 'fail') failed++;
    else if (r.status === 'warn') warned++;
    else passed++;
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

  return { failed, warned, passed };
}

export const checkCommand = new Command('check')
  .description('Run FreeAppStore compliance checks against the current directory.')
  .option('--dir <path>', 'Directory to check', process.cwd())
  .option('--json', 'Print machine-readable compliance results')
  .action(async (opts: { dir: string; json?: boolean }) => {
    const results = await runChecks(opts.dir);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      if (results.some((result) => result.status === 'fail')) process.exitCode = 1;
      return;
    }
    const { failed } = renderCheckResults(results);
    if (failed > 0) process.exit(1);
  });
