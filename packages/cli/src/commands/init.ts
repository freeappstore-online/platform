import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { rm, access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { assertValidAppId } from '../lib/app-id.js';

const TEMPLATES = {
  standalone: 'freeappstore-online/template-standalone',
  connected: 'freeappstore-online/template-connected',
} as const;

type TemplateName = keyof typeof TEMPLATES;

// File extensions we'll text-substitute through. Anything else (images,
// fonts, etc.) is left as-is. Conservative — better to miss a substitution
// than to corrupt a binary.
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.yaml',
  '.yml',
  '.toml',
  '.svg',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.cache']);

export const initCommand = new Command('init')
  .description('Scaffold a new free app from a template.')
  .argument('<app-id>', 'Short app id (lowercase, single word). e.g. "calendar"')
  .option('-t, --template <name>', 'Template: standalone | connected', 'standalone')
  .action(async (appId: string, opts: { template: string }) => {
    assertValidAppId(appId);
    const template = opts.template as TemplateName;
    if (!(template in TEMPLATES)) {
      throw new Error(`Unknown template "${opts.template}". Choose: standalone, connected.`);
    }

    const target = resolve(process.cwd(), appId);
    if (await exists(target)) {
      throw new Error(`Directory "${appId}" already exists.`);
    }

    const repo = TEMPLATES[template];
    process.stdout.write(`Cloning ${repo} → ${appId}/\n`);
    await run('git', ['clone', '--depth=1', `https://github.com/${repo}.git`, target]);
    await rm(join(target, '.git'), { recursive: true, force: true });

    // Replace APPNAME placeholder throughout. The template documents this
    // step in its README, but a CLI scaffold should never punt that on the
    // user — the result has to be runnable as-is.
    const replaced = await substituteAppName(target, appId);
    await run('git', ['init', '-q', '-b', 'main'], target);

    process.stdout.write(`\n✓ Scaffolded ${appId}/ from ${template} template.\n`);
    process.stdout.write(`  Replaced APPNAME → ${appId} in ${replaced} file(s).\n`);
    process.stdout.write(`  Next: cd ${appId} && pnpm install && pnpm dev\n`);
  });

async function substituteAppName(dir: string, appId: string): Promise<number> {
  let count = 0;
  for await (const file of walk(dir)) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const content = await readFile(file, 'utf8');
    if (!content.includes('APPNAME')) continue;
    await writeFile(file, content.split('APPNAME').join(appId));
    count++;
  }
  return count;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd });
    child.on('exit', (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`${cmd} exited with code ${code}`));
    });
    child.on('error', rejectFn);
  });
}
