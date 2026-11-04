import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../dist/commands/init.js';
import {
  APP_STARTER_CONFIG,
  getTemplateFiles,
  substituteAppName,
} from '../dist/lib/starter-foundation.js';

const previousCwd = process.cwd();
const previousIdentity = Object.fromEntries(
  ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map(
    (key) => [key, process.env[key]],
  ),
);
const root = await mkdtemp(join(tmpdir(), 'fas-fresh-starter-'));
const typecheckGuardrail = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../e2e/scaffold/typecheck-guardrail.mjs',
);
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'FAS starter test',
  GIT_AUTHOR_EMAIL: 'starter-test@example.invalid',
  GIT_COMMITTER_NAME: 'FAS starter test',
  GIT_COMMITTER_EMAIL: 'starter-test@example.invalid',
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed in ${cwd}`);
}

try {
  for (const preset of ['standalone', 'connected']) {
    const cwd = join(root, preset);
    await (await import('node:fs/promises')).mkdir(cwd, { recursive: true });
    process.chdir(cwd);
    const appId = `starter-${preset}`;
    await runInit({ appId, template: preset });
    const app = join(cwd, appId);
    const manifest = JSON.parse(await readFile(join(app, 'web/package.json'), 'utf8'));
    assert.equal(manifest.dependencies['@freeappstore/sdk'], '^0.16.32');
    const vite = await readFile(join(app, 'web/vite.config.ts'), 'utf8');
    assert.equal(
      (vite.match(/import\s+\{\s*pwaOptions/g) ?? []).length,
      1,
      `${preset} should wire one PWA config`,
    );
    if (preset === 'connected') {
      const screen = await readFile(join(app, 'web/src/App.tsx'), 'utf8');
      assert.match(screen, /<Shell app=\{fas\}/);
      assert.doesNotMatch(screen, /requireAuth/);
    }
    run('pnpm', ['install', '--no-frozen-lockfile'], app);
    run('pnpm', ['build'], app);
    run('pnpm', ['typecheck'], app);
    run(process.execPath, [typecheckGuardrail, app], app);
    run('pnpm', ['test'], app);
  }

  const displayName = 'Notes "Draft" [Beta] $ {draft} \\ café 📝';
  const appId = 'review-notes';
  const app = join(root, 'display-name', appId);
  for (const [path, contents] of Object.entries(
    substituteAppName(
      getTemplateFiles(APP_STARTER_CONFIG, 'generic', 'connected'),
      appId,
      displayName,
    ),
  )) {
    const file = join(app, path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, contents);
  }
  const packageInfo = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(app, 'web/public/manifest.json'), 'utf8'));
  assert.equal(packageInfo.name, appId);
  assert.equal(manifest.name, displayName);
  run('pnpm', ['install', '--no-frozen-lockfile'], app);
  run('pnpm', ['build'], app);
} finally {
  process.chdir(previousCwd);
  await rm(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousIdentity)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
