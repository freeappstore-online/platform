import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import prompts from 'prompts';
import { openUrl } from '../lib/open.js';
import { assertValidAppId } from '../lib/app-id.js';

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
    'Submit this app to FreeAppStore. Opens a GitHub Issue prefilled with everything you provide; a maintainer reviews and provisions hosting + DNS within ~48h.',
  )
  .option('--no-open', 'Print the URL instead of opening a browser.')
  .action(async (opts: { open: boolean }) => {
    const repo = await detectGitRepo();
    const appName = await detectAppName();
    const description = await detectDescription();

    process.stdout.write('\nLet\'s submit your app to FreeAppStore.\n');
    if (!repo) {
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
          message: 'One-line description',
          initial: description ?? '',
          validate: (v: string) => v.trim().length > 0 || 'required',
        },
        {
          type: 'text',
          name: 'description',
          message: 'Full description (what it does, who it\'s for)',
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
      description: answers.description!,
      repo: repo ? `https://github.com/${repo}` : null,
      demo: answers.demo?.trim() ? answers.demo : null,
    };

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
