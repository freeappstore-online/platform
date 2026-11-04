export interface SemverRangeOperations {
  validRange(range: string): string | null;
  minVersion(range: string): { version: string } | null;
  subset(sub: string, dom: string): boolean;
}

/** Worker-safe canonical capability definitions consumed by CLI and builder. */
export type CapabilityPackage = {
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
    validate: (content) =>
      content.toLowerCase().includes('room-restricted') && content.includes('public-read'),
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
    version: '1.0.1',
    dependencies: { persistence: '1.0.0' },
    packages: [{ name: '@freeappstore/sdk', range: '>=0.16.21', location: 'root' }],
    environment: 'browser',
    metadata: { data: 'device-only', import: 'explicit-merge-or-replace' },
    files: {
      'fas-capabilities/backup.ts': `/**
 * Validated backup and browser file export for device-local data.
 * Not fas.kv and not an account backup.
 * Installation and removal do not delete saved data or edited files.
 * previewBackup shows counts before any write. Validate the envelope before
 * writes and require an explicit merge or replace.
 * The app supplies apply and restore callbacks. If apply fails, the SDK attempts
 * to restore the snapshot; if that callback also fails, result.reason is
 * 'rollback' and stored data may be partial. Surface that failure; never claim
 * success or that the previous data is intact unless the result confirms it.
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
Call previewBackup before import; validation and checksum checks finish before
the SDK asks the app to apply any writes. Pass merge or replace explicitly. The
app supplies the apply and restore callbacks. After an apply failure the SDK
attempts to restore the saved snapshot. A successful restore is reported as a
failed import with the previous data restored. If restore fails, the result is
{ ok: false, reason: 'rollback' }, stored data may be partial, and the app must
surface the failure and provide a recovery path; do not claim old bytes or success.
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

    const removeUpdateGuard = registerMediaBusyGuard(
      pwa,
      () => recorder?.state !== 'inactive' || hasUnsavedMedia,
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

/** Resolve the canonical bundled registry in dependency order. This module is worker-safe. */
export function resolveCapabilities(
  ids: string[],
  source: Record<string, Capability> = registry,
): Capability[] {
  const result: Capability[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, requiredVersion?: string) => {
    const capability = Object.hasOwn(source, id) ? source[id] : undefined;
    if (!capability || (requiredVersion && capability.version !== requiredVersion))
      throw new Error(
        `Unknown or incompatible capability: ${id}${requiredVersion ? `@${requiredVersion}` : ''}`,
      );
    if (visiting.has(id)) throw new Error(`Capability dependency cycle: ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const [dependency, version] of Object.entries(capability.dependencies))
      visit(dependency, version);
    visiting.delete(id);
    done.add(id);
    result.push(capability);
  };
  for (const id of ids) visit(id);
  return result;
}

/** Shared conflict/dry-run change plan for filesystem and in-memory generators. */
export function planCapabilityChanges(
  capabilities: Capability[],
  currentFiles: Record<string, string>,
  owners: Record<string, string>,
  isUnmodifiedOwnedFile: (path: string, content: string) => boolean,
): { writes: Record<string, string>; changes: string[] } {
  const writes: Record<string, string> = {};
  const changes: string[] = [];
  const plannedOwners = new Map<string, string>();
  for (const capability of capabilities) {
    for (const [path, content] of Object.entries(capability.files)) {
      if (!capability.validate(content))
        throw new Error(`Capability validation failed: ${capability.id}/${path}`);
      const previousOwner = plannedOwners.get(path);
      if (previousOwner && previousOwner !== capability.id)
        throw new Error(`Multiple capabilities own ${path}`);
      plannedOwners.set(path, capability.id);
      const recordedOwner = owners[path];
      if (recordedOwner && recordedOwner !== capability.id)
        throw new Error(`Ownership conflict: ${path} belongs to ${recordedOwner}`);
      const current = currentFiles[path];
      if (current !== undefined && current !== content && !isUnmodifiedOwnedFile(path, current))
        throw new Error(
          `Edited or unowned file conflict: ${path}. Preserve your changes and resolve manually.`,
        );
      if (current !== content) {
        writes[path] = content;
        changes.push(
          `${current === undefined ? 'CREATE' : 'UPDATE'} ${path} (${capability.id}@${capability.version})`,
        );
      }
    }
  }
  return { writes, changes };
}

export function satisfiesCapabilityPackageRange(
  declared: unknown,
  required: string,
  semver: SemverRangeOperations,
): boolean {
  if (typeof declared !== 'string') return false;
  const actualRange = semver.validRange(declared);
  const requiredRange = semver.validRange(required);
  return Boolean(
    actualRange &&
      requiredRange &&
      semver.minVersion(actualRange) &&
      semver.subset(actualRange, requiredRange),
  );
}

export function checkCapabilityPackagePrerequisites(
  capabilities: Capability[],
  rootPackageText: string,
  webPackageText: string | undefined,
  semver: SemverRangeOperations,
): { checked: string[]; errors: string[] } {
  const root = JSON.parse(rootPackageText) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const web = webPackageText ? (JSON.parse(webPackageText) as typeof root) : undefined;
  const checked: string[] = [];
  const errors: string[] = [];
  for (const capability of capabilities) {
    for (const requirement of capability.packages ?? []) {
      // Web imports resolve from web/node_modules when a web manifest exists;
      // root-only apps resolve through the parent node_modules tree.
      const useWeb = requirement.location === 'web' && web !== undefined;
      const pkg = useWeb ? web : root;
      const file = useWeb ? 'web/package.json' : 'package.json';
      const declared =
        pkg?.dependencies?.[requirement.name] ?? pkg?.devDependencies?.[requirement.name];
      checked.push(
        `PREREQUISITE ${capability.id}: ${file} ${requirement.name} ${requirement.range} (declared ${declared ?? 'missing'})`,
      );
      if (!declared || !satisfiesCapabilityPackageRange(declared, requirement.range, semver))
        errors.push(
          `${capability.id}: ${file} requires ${requirement.name} ${requirement.range}; found ${declared ?? 'missing'}. Set a compatible explicit version/range and install dependencies. Workspace/link/file/git specs must be verified and replaced with a compatible published range before using this installer.`,
        );
    }
  }
  return { checked, errors };
}
