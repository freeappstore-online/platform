import { Command } from 'commander';
import { dim, green, red, yellow } from '../lib/style.js';
import { appDoctor } from '../one-shot/app-doctor.js';
import type { CheckResult } from '../one-shot/doctor.js';

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
  .description('Inspect app health; use --offline for account-free local development.')
  .option('--offline', 'Skip account configuration, authentication and API checks')
  .option('--json', 'Output a structured report')
  .option('--verify', 'Explicitly execute app-owned typecheck, test and selected build commands')
  .option('--artifact', 'Inspect declared built output and icon assets statically')
  .action(
    async (options: {
      offline?: boolean;
      json?: boolean;
      verify?: boolean;
      artifact?: boolean;
    }) => {
      const report = await appDoctor(options);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (
          report.checks.some((r) => r.status === 'fail') ||
          report.stages.some((s) => s.status === 'failed')
        )
          process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `CLI ${report.cliVersion ?? 'unknown'}; SDK ${report.sdk.resolved ?? 'not installed'} (declared ${report.sdk.declared ?? 'none'})\n`,
      );
      process.stdout.write(
        `Source ${report.revision ?? 'not committed'}${report.dirty ? ' (working changes)' : ''}; lock ${report.lock.present ? 'present, freshness not checked' : 'missing'}\n`,
      );
      process.stdout.write(
        `Package manager ${report.packageManager ?? 'not configured'}; capabilities ${
          Object.entries(report.capabilities)
            .map(([id, version]) => `${id}@${version ?? 'unknown'}`)
            .join(', ') || 'none declared'
        }\n`,
      );
      if (report.target)
        process.stdout.write(
          `App ${report.target.appId}: ${report.target.applicationRoot} -> ${report.target.outputPath}\n`,
        );
      const results = report.checks;
      let failed = 0;
      for (const r of results) {
        const icon = COLOR[r.status](ICON[r.status]);
        process.stdout.write(`${icon}  ${r.name.padEnd(20)} ${dim(r.detail)}\n`);
        if (r.status === 'fail') failed++;
      }
      for (const stage of report.stages) {
        process.stdout.write(`${stage.status.padEnd(14)} ${stage.name}: ${stage.detail}\n`);
        if (stage.status === 'failed') failed++;
      }
      if (failed > 0) process.exitCode = 1;
    },
  );
