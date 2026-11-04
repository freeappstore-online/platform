import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface Capability {
  id: string;
  version: string;
  dependencies: Record<string, string>;
  environment: 'browser';
  files: Record<string, string>;
  configChanges: string[];
  metadata?: Record<string, string>;
  validate: (content: string) => boolean;
}

/** Bounded, bundled first-party code only. No downloaded install hooks. */
export const registry: Record<string, Capability> = {
  pwa: {
    id: 'pwa',
    version: '1.0.0',
    dependencies: {},
    environment: 'browser',
    metadata: { install: 'manifest', updates: 'prompt-with-busy-guards', offline: 'shell-only' },
    files: {
      'web/src/fas-capabilities/pwa.ts': `// Import this module once from the browser entry point after installing SDK >=0.16.15.
import { startPwa } from '@freeappstore/sdk/pwa';
export const pwa = startPwa();
// pwa.addBusyGuard(() => dirtyForm || recorder.state === 'recording');
`,
      'web/fas-pwa-config.ts': `// Wrap the existing VitePWA options; retain app-specific manifest and caching configuration.
export { pwaOptions } from '@freeappstore/sdk/pwa-config';
`,
      'fas-capabilities/pwa.md': `# PWA integration

Requires @freeappstore/sdk >=0.16.15 and vite-plugin-pwa.
In web/vite.config.ts import pwaOptions from ./fas-pwa-config
and use VitePWA(pwaOptions({ /* your existing options */ })).
Import ./fas-capabilities/pwa from web/src/main.tsx.
Register pwa.addBusyGuard callbacks for dirty forms, recordings and transfers.
Keep the public manifest, icons and app-specific denylist. Review custom runtimeCaching:
never cache authenticated responses; the shared defaults cache only build assets.
Keep page zoom enabled; restrict gestures only on a canvas element.
See https://github.com/freeappstore-online/platform/blob/main/docs/pwa-lifecycle.md
`,
    },
    configChanges: [
      'Wrap VitePWA options with pwaOptions; import browser entry; declare busy guards',
    ],
    validate: (content) => content.length > 0,
  },
  connectivity: {
    id: 'connectivity',
    version: '1.0.0',
    dependencies: {},
    environment: 'browser',
    files: {
      'fas-capabilities/connectivity.ts': `/** Browser connectivity hints; online does not guarantee server reachability. */
export function watchConnectivity(listener: (online: boolean) => void): () => void {
  const update = () => listener(navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
`,
    },
    configChanges: [],
    validate: (content) => content.includes('export function watchConnectivity'),
  },
  persistence: {
    id: 'persistence',
    version: '1.0.0',
    dependencies: {},
    environment: 'browser',
    metadata: { data: 'device-only', account: 'fas.kv' },
    files: {
      'fas-capabilities/persistence.ts': `/**
 * Device-local persistence. This data is device-only. Not an account backup and not fas.kv.
 * Import this module from app code. Installation does not read or delete saved data.
 * A failed save returns { ok: false, reason } and must not be shown as saved.
 * watchPreference notifies other tabs; it does not merge and is not conflict resolution.
 * Put an app-owned resolveConflict on putFile when a file id may already exist.
 */
export {
  getPreference,
  setPreference,
  removePreference,
  watchPreference,
  openStore,
  getRecord,
  putRecord,
  deleteRecord,
  withTransaction,
  openFileStore,
  putFile,
  getFile,
  getFileMetadata,
  listFiles,
  installCapability,
  getCapability,
} from '@freeappstore/sdk/persist';
`,
      'fas-capabilities/persistence.md': `# Device-local persistence

Requires @freeappstore/sdk with the persist export (0.16.18 or newer).
This capability is device-only: localStorage and IndexedDB on this origin.
Account-backed keys stay on fas.kv. Public documents stay on fas.collections.
Import getPreference and the other helpers from fas-capabilities/persistence.ts.
Do not delete existing preference keys or databases when installing later.
A cross-tab watchPreference notice is a notification, not conflict resolution.
See https://github.com/freeappstore-online/platform/blob/main/docs/sdk.md
`,
    },
    configChanges: ['Import fas-capabilities/persistence.ts where the app reads device-local data'],
    validate: (content) => content.includes('device-only') && content.includes('getPreference'),
  },
};

export const presets: Record<string, string[]> = {
  minimal: [],
  connectivity: ['connectivity'],
  pwa: ['pwa'],
  persistence: ['persistence'],
};
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

export function resolveCapabilities(ids: string[], source = registry): Capability[] {
  const result: Capability[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(id: string, version?: string) {
    const cap = Object.hasOwn(source, id) ? source[id] : undefined;
    if (!cap || (version && cap.version !== version))
      throw new Error(`Unknown or incompatible capability: ${id}${version ? `@${version}` : ''}`);
    if (visiting.has(id)) throw new Error(`Capability dependency cycle: ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const [dep, required] of Object.entries(cap.dependencies)) visit(dep, required);
    visiting.delete(id);
    done.add(id);
    result.push(cap);
  }
  for (const id of ids) visit(id);
  return result;
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
  const manifestPath = await safePath(root, manifestName);
  const text = await readOptional(manifestPath);
  const manifest: Manifest = text ? JSON.parse(text) : { schemaVersion: 1, capabilities: {} };
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.capabilities ||
    typeof manifest.capabilities !== 'object'
  )
    throw new Error('Unsupported capability manifest.');
  const plan: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const owners = new Set<string>();
  for (const cap of resolveCapabilities(ids, options.source)) {
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
      if (owners.has(file)) throw new Error(`Multiple capabilities own ${file}`);
      owners.add(file);
      for (const [other, owned] of Object.entries(manifest.capabilities)) {
        if (other !== cap.id && Object.hasOwn(owned.files, file))
          throw new Error(`Ownership conflict: ${file} belongs to ${other}`);
      }
      if (!cap.validate(content))
        throw new Error(`Capability validation failed: ${cap.id}/${file}`);
      const path = await safePath(root, file);
      const current = await readOptional(path);
      const expected = old?.files[file];
      if (current !== undefined && current !== content && (!expected || hash(current) !== expected))
        throw new Error(
          `Edited or unowned file conflict: ${file}. Preserve your changes and resolve manually.`,
        );
      files[file] = hash(content);
      if (current !== content) {
        plan.push(
          `${current === undefined ? 'CREATE' : 'UPDATE'} ${file} (${cap.id}@${cap.version})\n${content
            .split('\n')
            .map((line) => `+ ${line}`)
            .join('\n')}`,
        );
        writes.push({ path, content });
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
