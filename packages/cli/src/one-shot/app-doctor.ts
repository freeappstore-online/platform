import { execFile as execFileCb, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  fsFileSource,
  inspectArtifactIcons,
  readBuildTarget,
  validateBuildTarget,
} from '@freeappstore/compliance';
import { satisfies, valid, validRange } from 'semver';
import { runDoctor } from './doctor.js';

const execFile = promisify(execFileCb);
const optionalText = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};
type Document = {
  version?: unknown;
  packageManager?: unknown;
  dependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  capabilities?: Record<string, { version?: unknown }>;
};
const json = async (path: string): Promise<Document | null> => {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};
const range = (value: unknown) =>
  typeof value === 'string' && value.length < 128 && validRange(value) ? value : null;
const semver = (value: unknown) => (typeof value === 'string' && valid(value) ? value : null);
export type Stage = {
  name: string;
  status: 'passed' | 'failed' | 'not-run' | 'not-configured';
  detail: string;
};

async function execute(command: string, root: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      stdio: 'ignore',
      signal: AbortSignal.timeout(300_000),
    });
    child.once('error', () => done(false));
    child.once('close', (code) => done(code === 0));
  });
}

/** Explicit local report; no dependency installs, fixes, auth flows, push or deploy. */
export async function appDoctor(
  options: { root?: string; offline?: boolean; verify?: boolean; artifact?: boolean } = {},
) {
  const root = options.root ?? process.cwd();
  const source = fsFileSource(root);
  const checks = await runDoctor({ root, offline: options.offline ?? false });
  let target = null;
  try {
    target = await readBuildTarget(source);
  } catch {
    /* Existing target check reports failure. */
  }
  const pkg = await json(join(root, 'package.json'));
  const appPkg = target ? await json(join(root, target.applicationRoot, 'package.json')) : null;
  const installedSdk = target
    ? await json(join(root, target.applicationRoot, 'node_modules/@freeappstore/sdk/package.json'))
    : null;
  const rootSdk = await json(join(root, 'node_modules/@freeappstore/sdk/package.json'));
  const ownPkg = await json(fileURLToPath(new URL('../../package.json', import.meta.url)));
  const lock = await optionalText(join(root, 'pnpm-lock.yaml'));
  const manifest = await json(join(root, '.fas-capabilities.json'));
  const capabilities = Object.fromEntries(
    Object.entries(manifest?.capabilities ?? {})
      .filter(([id]) => /^[a-z][a-z0-9-]*$/.test(id))
      .map(([id, entry]) => [id, semver((entry as { version?: unknown })?.version)]),
  );
  let revision: string | null = null;
  let dirty: boolean | null = null;
  try {
    const git = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
    revision = /^[a-f0-9]{40,64}$/.test(git.stdout.trim()) ? git.stdout.trim() : null;
    dirty = !!(
      await execFile('git', ['status', '--porcelain'], { cwd: root, maxBuffer: 1024 * 1024 })
    ).stdout;
  } catch {
    /* A local app need not already be a Git repo. */
  }
  checks.push({
    name: 'Dependency lock',
    status: lock === null ? 'warn' : 'pass',
    detail:
      lock === null
        ? 'No pnpm lockfile; first installation will create one'
        : 'pnpm lockfile present; freshness not checked (use frozen install when installing)',
  });
  const declaredSdk = range(
    appPkg?.dependencies?.['@freeappstore/sdk'] ?? pkg?.dependencies?.['@freeappstore/sdk'],
  );
  const resolvedSdk = semver(installedSdk?.version ?? rootSdk?.version);
  checks.push({
    name: 'SDK dependency',
    status:
      declaredSdk && resolvedSdk ? (satisfies(resolvedSdk, declaredSdk) ? 'pass' : 'fail') : 'warn',
    detail:
      declaredSdk && resolvedSdk
        ? `Declared ${declaredSdk}, installed ${resolvedSdk}`
        : 'SDK declaration or installed package not found; inspect dependencies and install locally',
  });
  const stages: Stage[] = [];
  for (const name of ['typecheck', 'tests', 'build']) {
    let command: string | null = null;
    const script = name === 'tests' ? 'test' : name;
    if (name === 'build') command = target?.buildCommand ?? null;
    else if (typeof pkg?.scripts?.[script] === 'string') command = `pnpm run ${script}`;
    else if (target && typeof appPkg?.scripts?.[script] === 'string')
      command = `pnpm --dir ${target.applicationRoot} run ${script}`;
    if (!command)
      stages.push({ name, status: 'not-configured', detail: 'No app-owned script configured' });
    else if (!options.verify)
      stages.push({
        name,
        status: 'not-run',
        detail: 'Run fas doctor --offline --verify to execute app scripts',
      });
    else if (
      !target ||
      checks.some((check) => check.name === 'Build/deploy target' && check.status === 'fail')
    )
      stages.push({
        name,
        status: 'not-run',
        detail: 'Correct the build/deploy target before verification',
      });
    else {
      const passed = await execute(command, root);
      stages.push({
        name,
        status: passed ? 'passed' : 'failed',
        detail: passed
          ? 'App-owned command completed'
          : 'App-owned command failed or timed out; run it locally for compiler/test output',
      });
    }
  }
  if (options.artifact && target) {
    checks.push(
      await validateBuildTarget(source, { artifact: true }),
      await inspectArtifactIcons(source, target.outputPath),
    );
    stages.push({
      name: 'artifact',
      status: checks.slice(-2).some((c) => c.status === 'fail') ? 'failed' : 'passed',
      detail: 'Declared output inspected statically; no browser executed',
    });
  } else
    stages.push({
      name: 'artifact',
      status: 'not-run',
      detail: options.artifact
        ? 'Correct the build target before inspecting artifacts'
        : 'Use --artifact to inspect the declared built output',
    });
  for (const name of ['browser', 'push', 'deployment'])
    stages.push({
      name,
      status: 'not-run',
      detail:
        name === 'browser'
          ? 'Run your browser tests or follow docs/app-verification.md; browser tooling is app-owned'
          : 'Not performed by doctor',
    });
  return {
    schemaVersion: 1,
    mode: options.offline ? 'local' : 'local-and-online',
    revision,
    dirty,
    cliVersion: semver(ownPkg?.version),
    sdk: {
      declared: declaredSdk,
      resolved: resolvedSdk,
    },
    packageManager:
      typeof pkg?.packageManager === 'string' && /^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager)
        ? pkg.packageManager
        : null,
    lock: {
      present: lock !== null,
      sha256: lock === null ? null : createHash('sha256').update(lock).digest('hex'),
      freshness: 'not-checked',
    },
    capabilities,
    target: target
      ? {
          ...target,
          buildCommand: /^[\w\s@./-]+$/.test(target.buildCommand)
            ? target.buildCommand
            : '[custom command configured; inspect fas.json locally]',
        }
      : null,
    checks,
    stages,
  };
}
