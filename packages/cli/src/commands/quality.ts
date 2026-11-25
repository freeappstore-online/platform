import { Command } from 'commander';
import { readConfig } from '../lib/config.js';
import { resolveAppIdOrExit } from '../lib/session.js';
import { bold, cyan, dim, green, red, yellow } from '../lib/style.js';

// Grade → color mapping
const GRADE_COLOR: Record<string, (s: string) => string> = {
  A: green,
  B: green,
  C: yellow,
  D: red,
  F: red,
};

function gradeColor(grade: string): (s: string) => string {
  return GRADE_COLOR[grade] ?? dim;
}

interface CheckDetail {
  name: string;
  score: number;
  grade: string;
  maxScore: number;
}

interface QualityIssue {
  file: string;
  line?: number;
  message: string;
}

interface QualityReport {
  score: number;
  grade: string;
  checks?: CheckDetail[];
  issues?: QualityIssue[];
  appId?: string;
  appName?: string;
}

export const qualityCommand = new Command('quality')
  .argument('[app-id]', 'App id (detected from current directory if omitted)')
  .description('Show VCQA code quality report for an app.')
  .option('--json', 'Output raw JSON instead of formatted summary.')
  .action(async (appIdArg?: string, opts?: { json?: boolean }) => {
    const appId = await resolveAppIdOrExit(appIdArg);

    const config = await readConfig();
    const url = `${config.apiBase}/v1/apps/${encodeURIComponent(appId)}/quality`;

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      process.stdout.write(`✗ Failed to reach quality API at ${url}\n`);
      process.exit(1);
    }

    if (res.status === 404) {
      process.stdout.write(`✗ No quality report found for "${appId}"\n`);
      process.exit(1);
    }
    if (!res.ok) {
      process.stdout.write(`✗ API error ${res.status}: ${await res.text()}\n`);
      process.exit(1);
    }

    const report = (await res.json()) as QualityReport;

    if (opts?.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    // Header: app name + score + grade
    const displayName = report.appName ?? appId;
    const gc = gradeColor(report.grade);
    process.stdout.write(
      `\n  ${bold(displayName)} ${dim('-- Code Quality:')} ${gc(report.grade)} ${dim(`(${report.score}/100)`)}\n\n`,
    );

    // Per-check grid (two columns)
    if (report.checks && report.checks.length > 0) {
      const checks = report.checks;
      const half = Math.ceil(checks.length / 2);
      const left = checks.slice(0, half);
      const right = checks.slice(half);

      for (let i = 0; i < half; i++) {
        const l = left[i]!;
        const r = right[i];

        const lLine = formatCheck(l);
        const rLine = r ? formatCheck(r) : '';
        process.stdout.write(`  ${lLine}${rLine}\n`);
      }
      process.stdout.write('\n');
    }

    // Top issues
    if (report.issues && report.issues.length > 0) {
      process.stdout.write(`  ${bold('Top issues:')}\n`);
      for (const issue of report.issues.slice(0, 10)) {
        const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file;
        process.stdout.write(`    ${dim(loc)} ${dim('--')} ${issue.message}\n`);
      }
      process.stdout.write('\n');
    }
  });

function formatCheck(check: CheckDetail): string {
  const icon = check.grade === 'A' || check.grade === 'B' ? green('✓') : red('✗');
  const gc = gradeColor(check.grade);
  const name = check.name.padEnd(14);
  const grade = gc(check.grade);
  const score = String(check.score).padStart(3);
  return `${icon} ${cyan(name)} ${grade} ${dim(score)}    `;
}
