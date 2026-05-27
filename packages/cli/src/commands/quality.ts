import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { readConfig } from '../lib/config.js';
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

/**
 * Detect the app-id from the current directory.
 *
 * Strategy:
 *   1. package.json "name" field (strip leading scope)
 *   2. CLAUDE.md content — look for `<something>.freeappstore.online`
 *   3. Directory basename
 */
async function detectAppId(): Promise<string | null> {
  // Try package.json name
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg.name) {
      // Strip npm scope: @freeappstore/timer → timer
      const bare = pkg.name.replace(/^@[^/]+\//, '');
      if (/^[a-z][a-z0-9-]{1,30}$/.test(bare)) return bare;
    }
  } catch {
    // no package.json, continue
  }

  // Try CLAUDE.md for subdomain
  try {
    const md = await readFile(join(process.cwd(), 'CLAUDE.md'), 'utf8');
    const m = /([a-z][a-z0-9-]{1,30})\.freeappstore\.online/.exec(md);
    if (m?.[1]) return m[1];
  } catch {
    // no CLAUDE.md, continue
  }

  return null;
}

export const qualityCommand = new Command('quality')
  .argument('[app-id]', 'App id (detected from current directory if omitted)')
  .description('Show VCQA code quality report for an app.')
  .option('--json', 'Output raw JSON instead of formatted summary.')
  .action(async (appIdArg?: string, opts?: { json?: boolean }) => {
    const appId = appIdArg ?? (await detectAppId());
    if (!appId) {
      process.stdout.write(
        '✗ Could not detect app-id. Pass it as an argument: fas quality <app-id>\n',
      );
      process.exit(1);
    }

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
