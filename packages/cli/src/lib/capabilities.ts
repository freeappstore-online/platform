import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gt, minVersion, subset, validRange } from 'semver';
import { satisfiesCapabilityPackageRange } from './capability-definitions.js';

type CapabilityPackage = {
  name: string;
  range: string;
  location: 'root' | 'web';
  section?: 'dependencies' | 'devDependencies';
};

export interface Capability {
  id: string;
  version: string;
  dependencies: Record<string, string>;
  /** Package requirements are separate from capability-ID dependencies. */
  packages?: CapabilityPackage[];
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
    packages: [
      { name: '@freeappstore/sdk', range: '>=0.16.15', location: 'web' },
      {
        name: 'vite-plugin-pwa',
        range: '^1.0.0',
        location: 'web',
        section: 'devDependencies',
      },
    ],
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

Requires @freeappstore/sdk >=0.16.15 and vite-plugin-pwa ^1.0.0.
In web/vite.config.ts import pwaOptions from ./fas-pwa-config
and use VitePWA(pwaOptions({ /* your existing options */ })).
Import ./fas-capabilities/pwa from web/src/main.tsx.
In features, import { pwa } from the same web/src/fas-capabilities/pwa module.
Register pwa.addBusyGuard callbacks for dirty forms, recordings and transfers; remove on cleanup.
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
  'cloud-data': {
    id: 'cloud-data',
    version: '1.0.0',
    dependencies: {},
    environment: 'browser',
    metadata: {
      models: 'device-local,private-account,public-shared,room-restricted',
      'device-local': 'sdk-persist',
      'private-account': 'sdk-kv',
      'public-shared': 'sdk-collections:public-read',
      'room-restricted': 'backend-http:data-rooms',
    },
    files: {
      'fas-capabilities/cloud-data.md': `# Cloud data access models

Device-local data uses @freeappstore/sdk/persist and does not sync.
Private per-account data uses fas.kv and requires sign-in.
Public shared data uses fas.collections and is public-read, owner-write.
Select it explicitly with collection(name, { visibility: 'public-read' }).
An owner query filter does not make a document private.
Room-restricted durable data uses authenticated backend data-room endpoints,
documented at https://github.com/freeappstore-online/platform/blob/main/docs/data-rooms.md.
The SDK does not yet wrap these endpoints. Realtime rooms are broadcast channels,
not authorization boundaries. Do not store hidden votes or private room data in
public collections.
See https://github.com/freeappstore-online/platform/blob/main/docs/sdk.md
`,
    },
    configChanges: [
      'Choose a data access model from fas-capabilities/cloud-data.md before storing app data',
    ],
    validate: (content) => content.includes('room-restricted') && content.includes('public-read'),
  },
  persistence: {
    id: 'persistence',
    packages: [{ name: '@freeappstore/sdk', range: '>=0.16.18', location: 'root' }],
    version: '1.0.0',
    dependencies: {},
    environment: 'browser',
    metadata: {
      data: 'device-local',
      account: 'private-per-account:fas.kv',
      shared: 'public-read:fas.collections',
      roomRestricted: 'backend-http:data-rooms',
    },
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
  backup: {
    id: 'backup',
    version: '1.0.0',
    dependencies: { persistence: '1.0.0' },
    packages: [{ name: '@freeappstore/sdk', range: '>=0.16.21', location: 'root' }],
    environment: 'browser',
    metadata: { data: 'device-only', import: 'explicit-merge-or-replace' },
    files: {
      'fas-capabilities/backup.ts': `/**
 * Validated backup and browser file export for device-local data.
 * Not fas.kv and not an account backup.
 * Installation and removal do not delete saved data or edited files.
 * previewBackup shows counts before any write. importBackup requires an explicit
 * merge or replace choice. A failed write restores the snapshot.
 */
export {
  exportBackup,
  previewBackup,
  importBackup,
  shareOrDownloadBackup,
  registerBackupCapability,
  mountBackupExample,
} from '@freeappstore/sdk/backup';
`,
      'fas-capabilities/backup.md': `# Validated backup

Requires @freeappstore/sdk/backup and the persistence capability.
Requires @freeappstore/sdk >=0.16.21. This recipe copies app-owned device-local data; it does not upload to fas.kv.
Call previewBackup before import. Pass merge or replace explicitly.
shareOrDownloadBackup shares the file, downloads it, or returns JSON text, and
revokes any object URL it created. Installation and removal do not delete app data.
See https://github.com/freeappstore-online/platform/blob/main/docs/sdk.md
`,
    },
    configChanges: ['Import fas-capabilities/backup.ts where the app exports or imports a backup'],
    validate: (content) =>
      content.includes('do not delete') &&
      content.includes('merge') &&
      content.includes('replace') &&
      content.includes('@freeappstore/sdk/backup'),
  },
  realtime: {
    id: 'realtime',
    version: '1.0.0',
    dependencies: {},
    packages: [{ name: '@freeappstore/sdk', range: '>=0.16.26', location: 'root' }],
    environment: 'browser',
    metadata: {
      transport: 'sdk-rooms:websocket-fanout',
      lifecycle: 'explicit-close,unsubscribe,reconnect-state',
      access: 'ephemeral-broadcast-not-private',
      transfer: 'p2p-app-owned',
    },
    files: {
      'fas-capabilities/realtime.ts': `import type { FreeAppStore, Room, ConnectionState } from '@freeappstore/sdk';

/** Join one ephemeral broadcast room and bind every listener to its lifetime. */
export function watchRoom(
  fas: FreeAppStore,
  roomId: string,
  handlers: {
    onState?: (state: ConnectionState) => void;
    onPeers?: (count: number) => void;
    onMessage?: (message: unknown) => void;
  },
  signal?: AbortSignal,
): { room: Room; close: () => void } {
  const room = fas.rooms.join(roomId);
  const unsubscribe = [
    room.onConnectionState((state) => handlers.onState?.(state)),
    room.onPeers((peers) => handlers.onPeers?.(peers.length)),
    room.onMessage((message) => handlers.onMessage?.(message)),
  ];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    for (const stop of unsubscribe) stop();
    room.close(); // cancels reconnect and releases the socket
  };
  if (signal?.aborted) close();
  else signal?.addEventListener('abort', close, { once: true });
  return { room, close };
}
`,
      'fas-capabilities/realtime.md': `# Optional realtime rooms

Requires @freeappstore/sdk >=0.16.26. Import watchRoom from
fas-capabilities/realtime.ts; keep its returned close function in the owning
component's cleanup or pass an AbortSignal. The helper unsubscribes all handlers,
closes the room and cancels reconnect on disposal. Observe connecting/open/closed/error
to render reconnect state; messages sent while disconnected are dropped.

fas.rooms is a small ephemeral WebSocket broadcast adapter, not durable storage,
an access-control list, or a private room. Validate message shape and size in your
app. Use it for low-state presence or coordination, not file transfer. WebShare's
receiver acknowledgement, checksum and flow-control lessons remain essential for
P2P transfer; signaling and P2P transport stay app-owned and must remain the
transport choice for large files. Do not tunnel files through room messages.

Room use requires sign-in and a supported WebSocket connection. Reconnect is
automatic with bounded backoff; close() is permanent. Data is not persisted and
the server may evict idle rooms. Register a PWA busy guard only for active work
that must finish before reload; an idle room alone need not block an update.
The room captures the authenticated identity when it connects. On sign-out or
account change, close it and join a new room after the replacement session is
ready; do not expect an existing socket to switch profiles.
This recipe creates no room until imported and used, and installs no service.
`,
    },
    configChanges: ['Import realtime helpers only in features that need ephemeral room messages'],
    validate: (content) =>
      content.startsWith('# Optional realtime rooms') ||
      (content.includes('room.close()') &&
        content.includes('removeEventListener') &&
        content.includes('AbortSignal')),
  },
  media: {
    id: 'media',
    version: '1.0.0',
    dependencies: {},
    environment: 'browser',
    packages: [{ name: '@freeappstore/sdk', range: '>=0.16.26', location: 'root' }],
    metadata: {
      permissions: 'user-gesture-only,no-persistent-grants',
      lifecycle: 'tracks-stopped,recorder-stop,busy-update-guard-removable',
      export: 'share-or-download',
      mobileTabCapture: 'unsupported',
    },
    files: {
      'fas-capabilities/media.ts': `// Shared capture, permission, cleanup, export and PWA-guard lifecycle.
// Keep recording UI, event handlers and app-specific file naming in this app.
export {
  mediaSupport,
  requestCapture,
  chooseRecordingType,
  stopTracks,
  stopRecording,
  registerMediaBusyGuard,
  exportRecording,
} from '@freeappstore/sdk/media';
export type { CaptureKind, MediaExportResult, MediaSupport } from '@freeappstore/sdk/media';
`,
      'fas-capabilities/media.md': `# Optional browser media

This recipe uses browser APIs only; it provisions no service and stores no media.
Call requestCapture directly from a user gesture. Permission denial rejects and
must be shown as a recoverable app error. Browser permission prompts cannot be
programmatically dismissed: aborting while the prompt is open stops tracks if a
stream arrives later. Call stopRecording(recorder, stream) when a recording
finishes, is cancelled or its component unmounts; it lets the recorder emit its
final data before stopping tracks. For preview-only capture, call stopTracks.
No persistent permission grant is requested.

Use mediaSupport before showing controls. Choose a recording MIME type at runtime
with chooseRecordingType and handle an empty result as the browser default or an
unsupported recording path. Export with exportRecording; it shares a file when
the platform supports file sharing and otherwise downloads it. Revoke any object
URLs your own preview creates. The PWA busy guard should cover active recording
and unsaved media, then be removed when the feature unmounts:

    // Import { pwa } from '../fas-capabilities/pwa' in web/src components.
    // Reuse the app-owned controller; never startPwa in media features.
    const removeUpdateGuard = registerMediaBusyGuard(
      pwa,
      () => Boolean(recorder && recorder.state !== 'inactive') || hasUnsavedMedia,
    );
    // On cleanup: await stopRecording(recorder, stream); removeUpdateGuard();

Microphone/camera support requires a secure context and user permission. Display
capture is not consistently available on mobile, especially browser-tab capture;
show a clear unsupported state and let users choose an existing file or another
device. Do not claim tab/audio capture works on mobile. Never start capture on
mount or silently retry a denied permission.
`,
    },
    configChanges: ['Import media helpers only from a user-triggered capture or export feature'],
    validate: (content) =>
      content.startsWith('# Optional browser media') ||
      (content.includes("from '@freeappstore/sdk/media'") &&
        content.includes('registerMediaBusyGuard') &&
        content.includes('exportRecording')),
  },
};

export const presets: Record<string, string[]> = {
  minimal: [],
  connectivity: ['connectivity'],
  pwa: ['pwa'],
  persistence: ['persistence'],
  backup: ['backup'],
  realtime: ['realtime'],
  media: ['media'],
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
interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
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

/**
 * Prepare package dependencies only in freshly cloned platform templates.
 * Existing apps still go through the strict installer preflight and are never
 * normalized by `fas add`.
 */
export async function normalizeFreshCapabilityPackages(rootPath: string, ids: string[]) {
  const root = resolve(rootPath);
  const capabilities = resolveCapabilities(ids);
  const rootText = await readOptional(join(root, 'package.json'));
  if (!rootText) throw new Error('Fresh template has no root package.json.');
  const rootPackage = JSON.parse(rootText) as PackageManifest;
  const webPath = join(root, 'web/package.json');
  const webText = await readOptional(webPath);
  const webPackage = webText ? (JSON.parse(webText) as PackageManifest) : undefined;
  let rootChanged = false;
  let webChanged = false;

  const byPackage = new Map<string, { requirement: CapabilityPackage; target: 'root' | 'web' }[]>();
  for (const capability of capabilities) {
    for (const requirement of capability.packages ?? []) {
      const target = requirement.location === 'web' && webPackage ? 'web' : 'root';
      const requirements = byPackage.get(requirement.name) ?? [];
      requirements.push({ requirement, target });
      byPackage.set(requirement.name, requirements);
    }
  }

  for (const [name, requirements] of byPackage) {
    const minima = requirements.map(({ requirement }) => minVersion(requirement.range));
    const validMinima = minima.filter(
      (minimum): minimum is NonNullable<typeof minimum> => minimum !== null,
    );
    if (validMinima.length !== minima.length) continue;
    const minimum = validMinima.reduce((floor, candidate) =>
      gt(candidate, floor) ? candidate : floor,
    );
    // A bounded range satisfies the selected minimum without silently admitting
    // a future breaking major when npm resolves the fresh template.
    const bounded = `^${minimum.version}`;
    if (!requirements.every(({ requirement }) => subset(bounded, requirement.range))) continue;

    const targets = new Map<'root' | 'web', CapabilityPackage[]>();
    for (const { requirement, target } of requirements) {
      const atTarget = targets.get(target) ?? [];
      atTarget.push(requirement);
      targets.set(target, atTarget);
    }

    for (const [target, targetRequirements] of targets) {
      const manifest = target === 'web' ? webPackage! : rootPackage;
      const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
      if (typeof declared === 'string') {
        // Keep any valid template range already compatible with every selected
        // recipe. Invalid custom specs remain for the strict preflight to reject.
        if (
          !validRange(declared) ||
          requirements.every(({ requirement }) => subset(declared, requirement.range))
        ) {
          continue;
        }
      }

      const section =
        manifest.dependencies?.[name] !== undefined
          ? 'dependencies'
          : manifest.devDependencies?.[name] !== undefined
            ? 'devDependencies'
            : (targetRequirements[0]?.section ?? 'dependencies');
      if (section === 'dependencies') {
        manifest.dependencies ??= {};
        manifest.dependencies[name] = bounded;
      } else {
        manifest.devDependencies ??= {};
        manifest.devDependencies[name] = bounded;
      }
      if (target === 'web') webChanged = true;
      else rootChanged = true;
    }
  }

  if (webChanged && webPackage) {
    await writeFile(webPath, `${JSON.stringify(webPackage, null, 2)}\n`);
  }
  if (rootChanged) {
    await writeFile(join(root, 'package.json'), `${JSON.stringify(rootPackage, null, 2)}\n`);
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
  const prerequisites: string[] = [];
  const checked: string[] = [];
  for (const cap of capabilities) {
    for (const requirement of cap.packages ?? []) {
      // Resolve from the generated import's directory. A root-level persistence
      // module cannot import dependencies installed only under web/node_modules.
      const web =
        requirement.location === 'web'
          ? await readOptional(await safePath(root, 'web/package.json'))
          : undefined;
      const location = web ? 'web/package.json' : 'package.json';
      const pkg = JSON.parse(web ?? packageText);
      const declared =
        pkg.dependencies?.[requirement.name] ?? pkg.devDependencies?.[requirement.name];
      checked.push(
        `PREREQUISITE ${cap.id}: ${location} ${requirement.name} ${requirement.range} (declared ${declared ?? 'missing'})`,
      );
      if (!satisfiesCapabilityPackageRange(declared, requirement.range)) {
        prerequisites.push(
          `${cap.id}: ${location} requires ${requirement.name} ${requirement.range}; found ${declared ?? 'missing'}. Set a compatible explicit version/range and install dependencies. Workspace/link/file/git specs must be verified and replaced with a compatible published range before using this installer.`,
        );
      }
    }
  }
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
  const plan: string[] = options.dryRun ? checked : [];
  const writes: { path: string; content: string }[] = [];
  const owners = new Set<string>();
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
