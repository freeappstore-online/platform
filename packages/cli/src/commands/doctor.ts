import { Command } from 'commander';
import { dim, green, red, yellow } from '../lib/style.js';
import { type CheckResult, runDoctor } from '../one-shot/doctor.js';

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

export const doctorCommand = new Command('doctor')
  .description('Run local health checks (signed-in, API reachable, tools, etc.).')
  .action(async () => {
    const results = await runDoctor();
    let failed = 0;
    for (const r of results) {
      const icon = COLOR[r.status](ICON[r.status]);
      process.stdout.write(`${icon}  ${r.name.padEnd(20)} ${dim(r.detail)}\n`);
      if (r.status === 'fail') failed++;
    }
    if (failed > 0) process.exit(1);
  });
