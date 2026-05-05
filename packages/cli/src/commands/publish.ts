import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { openUrl } from '../lib/open.js';

const PORTAL_URL = 'https://publish.freeappstore.online';

export const publishCommand = new Command('publish')
  .description('Open the FreeAppStore publisher portal for the current repo.')
  .option('--no-open', 'Print the URL instead of opening a browser.')
  .action(async (opts: { open: boolean }) => {
    const repo = await detectGitRepo();

    const url = new URL(PORTAL_URL);
    if (repo) url.searchParams.set('repo', repo);
    url.searchParams.set('source', 'cli');

    if (opts.open) {
      process.stdout.write(`Opening ${url.origin}${url.pathname}...\n`);
      await openUrl(url.toString());
    } else {
      process.stdout.write(`${url.toString()}\n`);
    }
  });

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
