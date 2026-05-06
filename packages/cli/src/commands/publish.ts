import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import prompts from 'prompts';
import { runChecks } from '@freeappstore/compliance';
import { openUrl } from '../lib/open.js';
import { assertValidAppId } from '../lib/app-id.js';
import { readConfig } from '../lib/config.js';
import { renderCheckResults } from './check.js';

const SUBMISSION_URL = 'https://github.com/freeappstore-online/submissions/issues/new';

// Must match the dropdown options in
// freeappstore-online/submissions/.github/ISSUE_TEMPLATE/app-submission.yml
const CATEGORIES = [
  'Learning',
  'Strategy',
  'Discovery',
  'Brain Training',
  'Social',
  'Productivity',
  'Health & Fitness',
  'Finance',
  'News & Weather',
  'Utilities',
  'Other (specify in description)',
] as const;

const TYPES = [
  'Standalone (no backend, localStorage only)',
  'Connected (Firebase/Supabase backend, shared with Pro version)',
] as const;

interface SubmissionInput {
  name: string;
  category: (typeof CATEGORIES)[number];
  type: (typeof TYPES)[number];
  oneliner: string;
  description: string;
  repo: string | null;
  demo: string | null;
}

export const publishCommand = new Command('publish')
  .description(
    'Publish this app to FreeAppStore. Provisions repo + hosting + DNS automatically. If auto-provision is unavailable, falls back to opening a prefilled submission Issue for admin review.',
  )
  .option('--no-open', 'Print the fallback Issue URL instead of opening a browser.')
  .option('--issue', 'Skip auto-provision; always open the GitHub Issue form.')
  .option('--skip-checks', 'Skip compliance checks (not recommended — your submission may be rejected).')
  .action(async (opts: { open: boolean; issue?: boolean; skipChecks?: boolean }) => {
    // Check auth BEFORE prompting — there's no point asking the user for
    // 5 fields just to bail at the end with "not signed in". --issue
    // skips this since the GitHub Issue form path doesn't need a session.
    if (!opts.issue) {
      const config = await readConfig();
      if (!config.session?.token) {
        process.stdout.write(
          '\n⚠  Not signed in. Run: fas login\n' +
            '   (or run `fas publish --issue` to submit via the GitHub Issue form instead.)\n',
        );
        process.exit(1);
      }
    }

    // Run compliance checks BEFORE prompts so a doomed submission fails
    // fast. Hard fails block; warnings allow through. Bypass with
    // --skip-checks if you really need to (admin review will still
    // catch issues).
    if (!opts.skipChecks) {
      process.stdout.write('Running compliance checks...\n\n');
      const results = await runChecks(process.cwd());
      const { failed } = renderCheckResults(results);
      if (failed > 0) {
        process.stdout.write(
          '\n⚠  Fix the failures above before publishing, or pass --skip-checks to bypass.\n',
        );
        process.exit(1);
      }
      process.stdout.write('\n');
    }

    const repo = await detectGitRepo();
    const appName = await detectAppName();
    const description = await detectDescription();

    process.stdout.write('\nLet\'s publish your app to FreeAppStore.\n');
    if (!repo && opts.issue) {
      process.stdout.write(
        '⚠  No GitHub origin detected. Push your repo to GitHub first, then run again.\n',
      );
    }

    const answers = (await prompts(
      [
        {
          type: 'text',
          name: 'name',
          message: 'App id (lowercase, used as subdomain)',
          initial: appName ?? '',
          validate: (value: string) => {
            try {
              assertValidAppId(value);
              return true;
            } catch (e) {
              return e instanceof Error ? e.message : 'invalid';
            }
          },
        },
        {
          type: 'select',
          name: 'category',
          message: 'Category (one app per category — check freeappstore.online for what\'s taken)',
          choices: CATEGORIES.map((c) => ({ title: c, value: c })),
        },
        {
          type: 'select',
          name: 'type',
          message: 'App type',
          choices: TYPES.map((t) => ({ title: t, value: t })),
        },
        {
          type: 'text',
          name: 'oneliner',
          message: 'One-line description (shown on the storefront)',
          initial: description ?? '',
          validate: (v: string) => v.trim().length > 0 || 'required',
        },
        {
          type: 'text',
          name: 'demo',
          message: 'Demo URL (optional, leave blank if none)',
        },
      ],
      {
        onCancel: () => {
          process.stdout.write('\nCanceled.\n');
          process.exit(1);
        },
      },
    )) as Partial<SubmissionInput>;

    const input: SubmissionInput = {
      name: answers.name!,
      category: answers.category!,
      type: answers.type!,
      oneliner: answers.oneliner!,
      // Reuse the oneliner as the body description for the Issue-form
      // fallback. Auto-provision flow doesn't use it (admin's storefront
      // uses oneliner directly).
      description: answers.oneliner!,
      repo: repo ? `https://github.com/${repo}` : null,
      demo: answers.demo?.trim() ? answers.demo : null,
    };

    // Try auto-provision first unless the user explicitly asked for the
    // Issue-form fallback.
    if (!opts.issue) {
      const autoResult = await tryAutoProvision(input);
      if (autoResult.kind === 'success') {
        process.stdout.write(`\n✓ Provisioned!\n`);
        process.stdout.write(`  Live at: ${autoResult.appUrl}\n`);
        process.stdout.write(`  Repo:    ${autoResult.repoUrl}\n\n`);
        process.stdout.write(`Push your code:\n`);
        process.stdout.write(`  git remote add upstream ${autoResult.repoUrl}.git\n`);
        process.stdout.write(`  git push upstream main\n`);
        return;
      }
      if (autoResult.kind === 'unauthorized') {
        process.stdout.write(`\n⚠  Not signed in. Run: fas login\n`);
        return;
      }
      process.stdout.write(
        `\n⚠  Auto-provision unavailable (${autoResult.reason}); falling back to Issue form.\n`,
      );
    }

    // Fallback: prefilled GitHub Issue form for admin review.
    const url = buildSubmissionUrl(input);
    if (opts.open) {
      process.stdout.write('\nOpening submission form on GitHub...\n');
      process.stdout.write('Review the prefilled fields and click "Submit new issue".\n');
      process.stdout.write('A maintainer will provision your app within ~48h.\n');
      await openUrl(url);
    } else {
      process.stdout.write(`\n${url}\n`);
    }
  });

interface AutoProvisionSuccess {
  kind: 'success';
  appUrl: string;
  repoUrl: string;
}
interface AutoProvisionFailure {
  kind: 'unconfigured' | 'failed' | 'unauthorized';
  reason: string;
}
type AutoProvisionResult = AutoProvisionSuccess | AutoProvisionFailure;

async function tryAutoProvision(input: SubmissionInput): Promise<AutoProvisionResult> {
  const config = await readConfig();
  const sessionToken = config.session?.token;
  if (!sessionToken) return { kind: 'unauthorized', reason: 'no fas session' };

  const typeShort = input.type.startsWith('Standalone') ? 'standalone' : 'connected';
  const res = await fetch(`${config.apiBase}/v1/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: input.name,
      category: input.category,
      type: typeShort,
      oneliner: input.oneliner,
      description: input.description,
      repo: input.repo,
      demo: input.demo,
    }),
  });
  if (res.status === 401) return { kind: 'unauthorized', reason: 'session expired' };
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { kind: 'unconfigured', reason: body.error ?? '503' };
  }
  if (!res.ok) {
    const body = await res.text();
    return { kind: 'failed', reason: `${res.status}: ${body}` };
  }
  const result = (await res.json()) as { appUrl: string; repoUrl: string };
  return { kind: 'success', appUrl: result.appUrl, repoUrl: result.repoUrl };
}

export function buildSubmissionUrl(input: SubmissionInput): string {
  const url = new URL(SUBMISSION_URL);
  url.searchParams.set('template', 'app-submission.yml');
  url.searchParams.set('title', `[Submission] ${input.name}`);
  url.searchParams.set('name', input.name);
  url.searchParams.set('category', input.category);
  url.searchParams.set('type', input.type);
  url.searchParams.set('oneliner', input.oneliner);
  url.searchParams.set('description', input.description);
  if (input.repo) url.searchParams.set('repo', input.repo);
  if (input.demo) url.searchParams.set('demo', input.demo);
  return url.toString();
}

async function detectAppName(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: string };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

async function detectDescription(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { description?: string };
    return pkg.description ?? null;
  } catch {
    return null;
  }
}

function detectGitRepo(): Promise<string | null> {
  return new Promise((resolveFn) => {
    const child = spawn('git', ['remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => (buf += chunk.toString()));
    child.on('close', (code) => {
      if (code !== 0) resolveFn(null);
      else resolveFn(parseGitHubRepo(buf.trim()));
    });
    child.on('error', () => resolveFn(null));
  });
}

export function parseGitHubRepo(url: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || !m[1] || !m[2]) return null;
  return `${m[1]}/${m[2]}`;
}
