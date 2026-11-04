import { spawn } from 'node:child_process';
import { appendFile, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { checkDeployTarget, fsFileSource, parseDeployTarget } from '@freeappstore/compliance';
import { Command } from 'commander';
import { loadPlaywright, startServer } from './screencheck.js';

/** Resolve symlinks too: an innocent-looking output path must not upload outside the repo. */
export async function containedPath(repo: string, path: string): Promise<string> {
  const base = await realpath(repo);
  const full = await realpath(resolve(base, path));
  const rel = relative(base, full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== full) {
    throw new Error(`Deploy path escapes repository: ${path}`);
  }
  return full;
}

export async function runBuildcheck(dir: string, expectedId?: string): Promise<string> {
  const root = resolve(dir);
  const target = parseDeployTarget(await readFile(join(root, 'fas.json'), 'utf8'));
  if (!target)
    throw new Error('Add an explicit fas.json deploy contract before building for release.');
  const check = await checkDeployTarget(fsFileSource(root), expectedId);
  if (check.status !== 'pass') throw new Error(check.detail);
  const cwd = await containedPath(root, target.root);
  // Fail rather than validate a stale artifact after a no-op/wrong build command.
  try {
    await lstat(join(root, target.output));
    throw new Error(
      `Output ${target.output} already exists. Choose fresh output or explicitly clear known build artifacts before fas buildcheck; stale artifacts are not release evidence.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await new Promise<void>((done, reject) => {
    const child = spawn(target.command, { cwd, shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? done() : reject(new Error(`Build command exited ${code}`)),
    );
  });
  const output = await containedPath(root, target.output);
  await rejectSymlinks(output);
  await readFile(join(output, 'index.html'), 'utf8');
  const chromium = await loadPlaywright(root);
  if (!chromium)
    throw new Error(
      'Rendered smoke requires Playwright: pnpm add -Dw playwright && pnpm exec playwright install chromium',
    );
  const server = await startServer(output, 0);
  try {
    const browser = await chromium.launch();
    try {
      const page = (await browser.newPage({})) as {
        goto(url: string, options: unknown): Promise<unknown>;
        locator(selector: string): {
          filter(options: { hasText: string }): {
            first(): { waitFor(options: unknown): Promise<void> };
          };
        };
        on(event: string, callback: (error: Error) => void): void;
      };
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${server.url}${target.smoke.path ?? '/'}`, { waitUntil: 'networkidle' });
      try {
        await page
          .locator(target.smoke.selector)
          .filter({ hasText: target.smoke.text })
          .first()
          .waitFor({ state: 'visible', timeout: 10000 });
      } catch {
        throw new Error(
          `Release artifact did not render ${target.smoke.selector} containing "${target.smoke.text}". The build may still ship the starter or ignore your developed app (${target.root}).`,
        );
      }
      if (errors.length) throw new Error(`Release artifact runtime errors: ${errors.join('; ')}`);
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
  process.stdout.write(`Verified ${check.detail}\nRendered feature: ${target.smoke.text}\n`);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `output=${target.output}\n`);
  return target.output;
}

async function rejectSymlinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error(`Release output contains a symlink: ${join(dir, entry.name)}`);
    if (entry.isDirectory()) await rejectSymlinks(join(dir, entry.name));
  }
}

export const buildcheckCommand = new Command('buildcheck')
  .description(
    'Build the declared app and verify a rendered feature in the exact upload directory.',
  )
  .option('--dir <path>', 'Repository root', process.cwd())
  .option('--app-id <id>', 'Expected hosting id (required in deploy CI)')
  .action(async (opts: { dir: string; appId?: string }) => {
    await runBuildcheck(opts.dir, opts.appId);
  });
