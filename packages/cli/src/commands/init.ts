import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { assertValidAppId } from '../lib/app-id.js';
import {
  installCapabilities,
  normalizeFreshCapabilityPackages,
  presets,
  resolveCapabilities,
} from '../lib/capabilities.js';
import {
  getTemplateFiles,
  substituteAppName as substituteStarterAppName,
} from '../lib/starter-foundation.js';
import { resolveStarterPreset } from '../lib/starter-presets.js';

const TEMPLATE_NAMES = ['standalone', 'connected', 'game-canvas', 'game-grid', 'game-3d'] as const;

const GAME_TEMPLATE_REPOS = {
  'game-canvas': 'freegamestore-online/template-game-canvas',
  'game-grid': 'freegamestore-online/template-game-grid',
  'game-3d': 'freegamestore-online/template-game-3d',
} as const;

type TemplateName = (typeof TEMPLATE_NAMES)[number];

/**
 * Templates that target FreeGameStore (vs FreeAppStore). Used by the
 * publish flow to default --store correctly when the user scaffolds
 * from a game template.
 */
export const GAME_TEMPLATES = new Set<TemplateName>(
  Object.keys(GAME_TEMPLATE_REPOS) as TemplateName[],
);

export const ALL_TEMPLATES = [...TEMPLATE_NAMES];

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

/**
 * Scaffolds a new app from a template. Exported so the wizard can call it
 * inline. Returns the absolute path to the new directory.
 */
export async function runInit(opts: {
  appId: string;
  template?: TemplateName;
  capabilities?: string[];
  preset?: string;
}): Promise<{ path: string; substitutionCount: number }> {
  assertValidAppId(opts.appId);
  const preset = opts.preset ?? 'minimal';
  if (!Object.hasOwn(presets, preset)) throw new Error(`Unknown preset: ${preset}`);
  const additions = [...(presets[preset] ?? []), ...(opts.capabilities ?? [])];
  const capabilities = GAME_TEMPLATES.has(opts.template ?? 'standalone')
    ? additions
    : resolveStarterPreset(
        opts.template === 'connected' ? 'connected' : 'standalone',
        additions,
      ).map((capability) => capability.id);
  resolveCapabilities(capabilities);
  const template = opts.template ?? 'standalone';
  if (!ALL_TEMPLATES.includes(template)) {
    throw new Error(`Unknown template "${template}". Choose: ${ALL_TEMPLATES.join(', ')}.`);
  }

  const target = resolve(process.cwd(), opts.appId);
  if (await exists(target)) {
    throw new Error(`Directory "${opts.appId}" already exists.`);
  }

  if (GAME_TEMPLATES.has(template)) {
    const repo = GAME_TEMPLATE_REPOS[template as keyof typeof GAME_TEMPLATE_REPOS];
    process.stdout.write(`Cloning ${repo} → ${opts.appId}/\n`);
    await run('git', ['clone', '--depth=1', `https://github.com/${repo}.git`, target]);
    await rm(join(target, '.git'), { recursive: true, force: true });
  } else {
    process.stdout.write(`Generating canonical ${template} starter → ${opts.appId}/\n`);
    const generated = getTemplateFiles(
      { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
      'generic',
      template === 'connected' ? 'connected' : 'standalone',
    );
    const files = substituteStarterAppName(generated, opts.appId, opts.appId);
    for (const [file, content] of Object.entries(files)) {
      const path = join(target, file);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
    }
  }

  // Replace APPNAME placeholder throughout. The template documents this
  // step in its README, but a CLI scaffold should never punt that on the
  // user — the result has to be runnable as-is.
  const substitutionCount = await substituteAppName(target, opts.appId);
  // Keep deployment identity explicit, preserving any template-specific layout.
  const configPath = join(target, 'fas.json');
  const config = (await exists(configPath)) ? JSON.parse(await readFile(configPath, 'utf8')) : {};
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        applicationRoot: 'web',
        outputPath:
          config.applicationRoot === '.' ? 'dist' : `${config.applicationRoot ?? 'web'}/dist`,
        buildCommand: 'pnpm build',
        ...config,
        appId: opts.appId,
      },
      null,
      2,
    )}\n`,
  );
  await normalizeFreshCapabilityPackages(target, capabilities);
  await installCapabilities(target, capabilities);
  await run('git', ['init', '-q', '-b', 'main'], target);

  // Stage and commit the template so the new repo has a real first commit.
  // Without this, `git push` after fas publish fails with "src refspec
  // main does not match any" because main points at nothing.
  await run('git', ['add', '-A'], target);
  await run('git', ['commit', '-q', '-m', `Initial commit from ${template} template`], target);

  return { path: target, substitutionCount };
}

export const initCommand = new Command('init')
  .description('Scaffold a new free app or game from a template.')
  .argument('<app-id>', 'Short id (lowercase, single word). e.g. "calendar" or "asteroids"')
  .option('-t, --template <name>', `Template: ${ALL_TEMPLATES.join(' | ')}`, 'standalone')
  .option('--capabilities <ids>', 'Comma-separated first-party capability IDs')
  .option(
    '--preset <name>',
    'Capability list: minimal | connectivity | pwa | persistence | backup | realtime | media',
    'minimal',
  )
  .action(
    async (appId: string, opts: { template: string; capabilities?: string; preset?: string }) => {
      if (!ALL_TEMPLATES.includes(opts.template as TemplateName)) {
        process.stderr.write(
          `Unknown template "${opts.template}". Choose: ${ALL_TEMPLATES.join(', ')}.\n`,
        );
        process.exit(1);
      }
      const result = await runInit({
        appId,
        template: opts.template as TemplateName,
        capabilities: opts.capabilities?.split(',').filter(Boolean) ?? [],
        preset: opts.preset ?? 'minimal',
      });
      const isGame = GAME_TEMPLATES.has(opts.template as TemplateName);
      const publishCmd = isGame ? 'fas publish --store games' : 'fas publish';
      const docsUrl = isGame
        ? 'https://freegamestore.online/contribute.html'
        : 'https://freeappstore.online/contribute.html';
      process.stdout.write(`\n✓ Scaffolded ${appId}/ from ${opts.template} template.\n`);
      process.stdout.write(
        isGame
          ? `  Replaced APPNAME → ${appId} in ${result.substitutionCount} file(s).\n\n`
          : `  App identity configured as ${appId}.\n\n`,
      );
      process.stdout.write('Next steps:\n');
      process.stdout.write(`  cd ${appId}\n`);
      process.stdout.write('  pnpm install            # one-time setup\n');
      process.stdout.write('  pnpm dev                # local dev server\n');
      process.stdout.write('  fas check               # compliance — run before publishing\n');
      // Pad the publish line so the `#` comment column aligns. Length
      // varies by store: `fas publish` (12) vs `fas publish --store games` (25).
      const padded = publishCmd.padEnd(23);
      process.stdout.write(`  ${padded} # provisions repo + hosting + DNS\n\n`);
      process.stdout.write(`Docs: ${docsUrl}\n`);
    },
  );

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
