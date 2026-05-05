import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openUrl } from '../lib/open.js';

const SUBMISSION_URL = 'https://github.com/freeappstore-online/submissions/issues/new';

export const publishCommand = new Command('publish')
  .description(
    'Open the FreeAppStore submission form for this app. A maintainer reviews and provisions hosting + DNS within ~48h.',
  )
  .option('--no-open', 'Print the URL instead of opening a browser.')
  .action(async (opts: { open: boolean }) => {
    const repo = await detectGitRepo();
    const appName = await detectAppName();

    const url = new URL(SUBMISSION_URL);
    url.searchParams.set('template', 'app-submission.yml');
    if (appName) {
      url.searchParams.set('name', appName);
      url.searchParams.set('title', `[Submission] ${appName}`);
    }
    if (repo) url.searchParams.set('repo', `https://github.com/${repo}`);

    if (opts.open) {
      process.stdout.write('Opening submission form on GitHub...\n');
      process.stdout.write('A maintainer will review and provision your app (~48h).\n');
      await openUrl(url.toString());
    } else {
      process.stdout.write(`${url.toString()}\n`);
    }
  });

/** Reads the app name from the local package.json — `fas init` sets this. */
async function detectAppName(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: string };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

/** Returns the GitHub repo of the current dir as `owner/name`, or null. */
function detectGitRepo(): Promise<string | null> {
  return new Promise((resolveFn) => {
    // We could parse .git/config ourselves, but it has multiple [remote "..."]
    // sections and naive regex matching picks the wrong one. Trust git.
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
  // Handles SSH (git@github.com:owner/name.git) and HTTPS, with optional
  // .git suffix and optional trailing slash. Allows dots in the repo name
  // (e.g. `node.js`).
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || !m[1] || !m[2]) return null;
  return `${m[1]}/${m[2]}`;
}
