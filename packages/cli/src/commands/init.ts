import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const TEMPLATES = {
  standalone: 'freeappstore-online/template-standalone',
  connected: 'freeappstore-online/template-connected',
} as const;

type TemplateName = keyof typeof TEMPLATES;

export const initCommand = new Command('init')
  .description('Scaffold a new free app from a template.')
  .argument('<app-id>', 'Short app id (lowercase, single word). e.g. "calendar"')
  .option('-t, --template <name>', 'Template: standalone | connected', 'standalone')
  .action(async (appId: string, opts: { template: string }) => {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(appId)) {
      throw new Error('app-id must be lowercase letters, digits, or hyphens (2-31 chars).');
    }
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
    await run('git', ['init', '-q', '-b', 'main'], target);

    process.stdout.write(`\n✓ Scaffolded ${appId}/ from ${template} template.\n`);
    process.stdout.write(`  Next: cd ${appId} && pnpm install && pnpm dev\n`);
  });

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
