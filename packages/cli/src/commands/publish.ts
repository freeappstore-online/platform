import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/** Try to detect the current GitHub repo as `owner/name`. */
async function detectGitRepo(): Promise<string | null> {
  // Prefer reading the `origin` URL out of git config rather than running git,
  // so this works even if git is missing.
  try {
    const config = await readFile(join(process.cwd(), '.git', 'config'), 'utf8');
    const match = /url\s*=\s*([^\n]+)/.exec(config);
    if (!match || !match[1]) return null;
    return parseGitHubRepo(match[1].trim());
  } catch {
    return spawnGitRemote();
  }
}

function spawnGitRemote(): Promise<string | null> {
  return new Promise((resolveFn) => {
    const child = spawn('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => (buf += chunk.toString()));
    child.on('close', (code) => {
      if (code !== 0) resolveFn(null);
      else resolveFn(parseGitHubRepo(buf.trim()));
    });
    child.on('error', () => resolveFn(null));
  });
}

function parseGitHubRepo(url: string): string | null {
  // matches both git@github.com:owner/name.git and https://github.com/owner/name(.git)
  const m = /github\.com[:/]([^/]+)\/([^/.\s]+?)(?:\.git)?$/.exec(url);
  if (!m || !m[1] || !m[2]) return null;
  return `${m[1]}/${m[2]}`;
}
