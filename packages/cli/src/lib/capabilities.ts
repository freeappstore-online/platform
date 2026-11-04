import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gt, minVersion, subset, validRange } from 'semver';

import {
  type Capability,
  checkCapabilityPackagePrerequisites,
  planCapabilityChanges,
  prepareFreshCapabilityPackageFiles,
  resolveCapabilities,
} from './capability-definitions.js';

export {
  type Capability,
  presets,
  registry,
  resolveCapabilities,
} from './capability-definitions.js';

interface Ownership {
  version: string;
  files: Record<string, string>;
  metadata?: Record<string, string>;
}
interface Manifest {
  schemaVersion: 1;
  capabilities: Record<string, Ownership>;
}
const manifestName = '.fas-capabilities.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Prepare package dependencies only in freshly cloned platform templates.
 * Existing apps still go through the strict installer preflight and are never
 * normalized by `fas add`.
 */
export async function normalizeFreshCapabilityPackages(rootPath: string, ids: string[]) {
  const root = resolve(rootPath);
  const rootText = await readOptional(join(root, 'package.json'));
  if (!rootText) throw new Error('Fresh template has no root package.json.');
  const webText = await readOptional(join(root, 'web/package.json'));
  const prepared = prepareFreshCapabilityPackageFiles(
    { 'package.json': rootText, ...(webText ? { 'web/package.json': webText } : {}) },
    ids,
    { validRange, minVersion, subset, gt },
  );
  if (prepared.files['web/package.json'] !== webText && prepared.files['web/package.json']) {
    await writeFile(join(root, 'web/package.json'), prepared.files['web/package.json']);
  }
  if (prepared.files['package.json'] !== rootText) {
    await writeFile(join(root, 'package.json'), prepared.files['package.json']!);
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Reject symlinks as well as traversal, including in existing parent directories. */
async function safePath(root: string, file: string): Promise<string> {
  if (
    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(file) ||
    file.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error(`Unsafe capability path: ${file}`);
  let current = root;
  for (const part of file.split('/')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink conflict: ${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

export async function installCapabilities(
  rootPath: string,
  ids: string[],
  options: {
    dryRun?: boolean;
    update?: boolean;
    source?: Record<string, Capability>;
    /** Injectable writer for failure/retry verification. */
    write?: typeof writeFile;
  } = {},
): Promise<string[]> {
  const root = resolve(rootPath);
  const packageText = await readOptional(join(root, 'package.json'));
  if (!packageText) throw new Error('Run fas add in an app root containing package.json.');
  JSON.parse(packageText);
  const capabilities = resolveCapabilities(ids, options.source);
  const needsWebPackage = capabilities.some((capability) =>
    capability.packages?.some((requirement) => requirement.location === 'web'),
  );
  const webPackageText = needsWebPackage
    ? await readOptional(await safePath(root, 'web/package.json'))
    : undefined;
  const { checked, errors: prerequisites } = checkCapabilityPackagePrerequisites(
    capabilities,
    packageText,
    webPackageText,
    { validRange, minVersion, subset },
  );
  if (prerequisites.length) {
    const report = [
      'INCOMPLETE: package prerequisites unmet; no files or manifest written.',
      ...prerequisites,
    ];
    if (options.dryRun) return report;
    throw new Error(report.join('\n'));
  }
  const manifestPath = await safePath(root, manifestName);
  const text = await readOptional(manifestPath);
  const manifest: Manifest = text ? JSON.parse(text) : { schemaVersion: 1, capabilities: {} };
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.capabilities ||
    typeof manifest.capabilities !== 'object'
  )
    throw new Error('Unsupported capability manifest.');
  const plannedPaths = [
    ...new Set(capabilities.flatMap((capability) => Object.keys(capability.files))),
  ];
  const currentFiles: Record<string, string> = {};
  const owners: Record<string, string> = {};
  for (const [owner, owned] of Object.entries(manifest.capabilities)) {
    for (const path of Object.keys(owned.files)) owners[path] = owner;
  }
  for (const file of plannedPaths) {
    const current = await readOptional(await safePath(root, file));
    if (current !== undefined) currentFiles[file] = current;
  }
  const capabilityPlan = planCapabilityChanges(
    capabilities,
    currentFiles,
    owners,
    (file, current) => {
      const owner = owners[file];
      const expectedHash = owner ? manifest.capabilities[owner]?.files[file] : undefined;
      return expectedHash !== undefined && hash(current) === expectedHash;
    },
  );
  const plan: string[] = options.dryRun ? checked : [];
  const writes = Object.entries(capabilityPlan.writes).map(([file, content]) => ({
    path: resolve(root, file),
    content,
  }));
  const changeByPath = new Map(
    capabilityPlan.changes.map((change) => [
      change.slice(change.indexOf(' ') + 1, change.indexOf(' (')),
      change,
    ]),
  );
  for (const cap of capabilities) {
    const old = Object.hasOwn(manifest.capabilities, cap.id)
      ? manifest.capabilities[cap.id]
      : undefined;
    if (!old && cap.configChanges.length)
      plan.push(`INTEGRATE ${cap.id}: ${cap.configChanges.join('; ')}`);
    if (old && old.version !== cap.version && !options.update)
      throw new Error(
        `${cap.id}: installed ${old.version}; review --dry-run --update before updating to ${cap.version}.`,
      );
    const files: Record<string, string> = {};
    for (const [file, content] of Object.entries(cap.files)) {
      await safePath(root, file);
      const current = currentFiles[file];
      files[file] = hash(content);
      if (current !== content) {
        const description = changeByPath.get(file);
        plan.push(
          `${description ?? `CREATE ${file} (${cap.id}@${cap.version})`}\n${content
            .split('\n')
            .map((line) => `+ ${line}`)
            .join('\n')}`,
        );
      }
    }
    // Removed files are retained and remain tracked: no implicit destructive migrations.
    manifest.capabilities[cap.id] = {
      version: cap.version,
      files: { ...old?.files, ...files },
      ...(cap.metadata ? { metadata: cap.metadata } : {}),
    };
  }
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== text) plan.push(`UPDATE ${manifestName}\n${next}`);
  if (!options.dryRun) {
    const write =
      options.write ??
      (async (path: string, content: string) => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, content, { flag: 'wx' });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    // Write files first. A retry safely adopts exact generated bytes if interrupted
    // before recording ownership; a differing file is always a conflict.
    for (const item of writes) {
      await mkdir(dirname(item.path), { recursive: true });
      await write(item.path, item.content);
    }
    if (next !== text) await write(manifestPath, next);
  }
  return plan.length ? plan : ['No changes.'];
}
