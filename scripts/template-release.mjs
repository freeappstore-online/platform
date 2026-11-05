// Release-only maintenance for the two first-party mirrors. Never runs in consumer apps.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const presets = ['standalone', 'connected'];
const digest = (body) => createHash('sha256').update(body).digest('hex');
const version = (v) => {
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('Expected a stable release version');
  return v.split('.').map(Number);
};
export function compareVersions(a, b) {
  const av = version(a),
    bv = version(b);
  return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
}
async function read(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function canonical(root, preset) {
  const { getTemplateFiles } = await import(
    pathToFileURL(resolve(root, 'packages/cli/dist/lib/starter-foundation.js'))
  );
  return getTemplateFiles(
    { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
    'generic',
    preset,
  );
}
export function planSync(previous, actual, desired, cliVersion) {
  for (const path of [...Object.keys(previous?.hashes ?? {}), ...Object.keys(desired)]) {
    if (
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) ||
      path.split('/').some((part) => part === '..' || part === '.')
    )
      throw new Error('Unsafe canonical path');
  }
  if (!previous?.hashes)
    throw new Error('Missing reviewed mirror baseline; initialize it locally first');
  if (compareVersions(cliVersion, previous.cliVersion) < 0)
    throw new Error('Refusing a release downgrade');
  for (const [path, hash] of Object.entries(previous.hashes)) {
    if (actual[path] == null || digest(actual[path]) !== hash)
      throw new Error(`Manual canonical edit: ${path}; reconcile it locally before syncing`);
  }
  for (const path of Object.keys(desired)) {
    if (!(path in previous.hashes) && actual[path] != null && actual[path] !== desired[path])
      throw new Error(`New canonical path conflicts with existing file: ${path}`);
  }
  return {
    writes: Object.fromEntries(
      Object.entries(desired).filter(([path, body]) => actual[path] !== body),
    ),
    deletes: Object.keys(previous.hashes).filter((path) => !(path in desired)),
    hashes: Object.fromEntries(Object.entries(desired).map(([path, body]) => [path, digest(body)])),
  };
}
export async function apply(
  root,
  platform,
  preset,
  release,
  bootstrap = false,
  allowWorkflowChanges = false,
) {
  if (!presets.includes(preset)) throw new Error('Unknown mirror preset');
  if (!/^[a-f0-9]{40}$/.test(release.sourceSha))
    throw new Error('Invalid accepted source revision');
  version(release.cliVersion);
  version(release.sdkVersion);
  const desired = await canonical(platform, preset);
  const statePath = resolve(root, '.fas-template/state.json');
  const state = JSON.parse((await read(statePath)) ?? 'null');
  const paths = new Set([...Object.keys(state?.hashes ?? {}), ...Object.keys(desired)]);
  for (const path of [...paths, '.fas-template/state.json']) {
    let current = root;
    for (const part of path.split('/')) {
      if (part === '..' || part === '.' || part.includes('\\'))
        throw new Error('Unsafe canonical path');
      current = resolve(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink conflict: ${path}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const actual = Object.fromEntries(
    await Promise.all([...paths].map(async (p) => [p, await read(resolve(root, p))])),
  );
  if (bootstrap && state) throw new Error('A baseline already exists');
  if (bootstrap && Object.entries(desired).some(([p, body]) => actual[p] !== body))
    throw new Error('Bootstrap requires exact reviewed canonical files');
  const previous = bootstrap
    ? {
        cliVersion: release.cliVersion,
        hashes: Object.fromEntries(Object.entries(desired).map(([p, b]) => [p, digest(b)])),
      }
    : state;
  const plan = planSync(previous, actual, desired, release.cliVersion);
  const workflowChanges = [...Object.keys(plan.writes), ...plan.deletes].filter((path) =>
    path.startsWith('.github/workflows/'),
  );
  if (workflowChanges.length && !allowWorkflowChanges)
    throw new Error(
      `Accepted release changes workflow files (${workflowChanges.join(', ')}). The default GITHUB_TOKEN lacks Workflows write permission. Use an authorized maintainer with --allow-workflow-changes, or configure TEMPLATE_SYNC_TOKEN scoped to the two mirrors with Contents, Workflows and Actions write. No files were changed.`,
    );
  for (const [p, body] of Object.entries(plan.writes)) {
    await mkdir(dirname(resolve(root, p)), { recursive: true });
    await writeFile(resolve(root, p), body);
  }
  for (const p of plan.deletes) await rm(resolve(root, p));
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({ ...release, preset, managedPaths: [...new Set([...(state?.managedPaths ?? []), ...paths])], hashes: plan.hashes }, null, 2)}\n`,
  );
  return [...paths, '.fas-template/state.json'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'accept') {
    const [publishedRoot, cliVersion, sdkVersion, sourceSha, output] = args;
    version(cliVersion);
    version(sdkVersion);
    for (const preset of presets) {
      const source = await canonical(process.cwd(), preset);
      const { getTemplateFiles } = await import(
        pathToFileURL(resolve(publishedRoot, 'lib/starter-foundation.js'))
      );
      const published = getTemplateFiles(
        { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
        'generic',
        preset,
      );
      if (JSON.stringify(source) !== JSON.stringify(published))
        throw new Error(`Published ${preset} generator differs from accepted source`);
    }
    const old = JSON.parse((await read(output)) ?? 'null');
    if (
      old &&
      (compareVersions(cliVersion, old.cliVersion) < 0 ||
        compareVersions(sdkVersion, old.sdkVersion) < 0)
    )
      throw new Error('Refusing to replace a newer accepted release');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify({ cliVersion, sdkVersion, sourceSha }, null, 2)}\n`);
  } else if (command === 'apply' || command === 'bootstrap') {
    const [root, preset, releaseFile] = args;
    const release = JSON.parse(await readFile(releaseFile, 'utf8'));
    if (
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== release.sourceSha
    )
      throw new Error('Platform checkout must match accepted source revision');
    await apply(
      root,
      process.cwd(),
      preset,
      release,
      command === 'bootstrap',
      args.includes('--allow-workflow-changes'),
    );
  } else if (command === 'lock-script') {
    const { INSTALL_APP_DEPENDENCIES } = await import(
      '../packages/cli/dist/lib/starter-dependencies.js'
    );
    process.stdout.write(INSTALL_APP_DEPENDENCIES);
  } else if (command === 'stage') {
    const [root] = args;
    const state = JSON.parse(await readFile(resolve(root, '.fas-template/state.json'), 'utf8'));
    execFileSync(
      'git',
      [
        'add',
        '--',
        ...(state.managedPaths ?? Object.keys(state.hashes)).filter((path) => {
          try {
            execFileSync('git', ['ls-files', '--error-unmatch', '--', path], {
              cwd: root,
              stdio: 'ignore',
            });
            return true;
          } catch {
            return path in state.hashes;
          }
        }),
        'pnpm-lock.yaml',
        '.fas-template/state.json',
      ],
      { cwd: root },
    );
  } else throw new Error('Expected accept, apply, bootstrap, lock-script or stage');
}
