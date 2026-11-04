import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { openFasDatabase } from './database.js';
import { failure, type StorageResult, startTransaction } from './status.js';

/**
 * Large files split into a small metadata record and a separate payload.
 *
 * Both object stores live in one device-local IndexedDB database. Metadata
 * reads do not load the payload. When a file id already exists, `putFile`
 * does not overwrite it unless the caller supplies `resolveConflict`. That
 * function is the app's merge policy. Returning null keeps both stored
 * copies and reports `conflict`. A cross-tab preference notice is not this
 * policy: notices only say that something changed.
 */

const METADATA = 'metadata';
const PAYLOADS = 'payloads';

export interface FileMetadata {
  id: string;
  name: string;
  contentType: string;
  byteLength: number;
  revision: number;
  updatedAt: number;
}

export interface StoredFile<M extends FileMetadata = FileMetadata> {
  metadata: M;
  payload: Uint8Array;
}

export interface FileStore {
  readonly namespace: string;
  readonly database: IDBPDatabase;
  close(): void;
}

export async function openFileStore(options: {
  namespace: string;
  /** Integer schema version. Defaults to 1, which creates the two stores. */
  version?: number;
  upgrade?:
    | ((
        database: {
          objectStoreNames: DOMStringList;
          createObjectStore(name: string, options?: IDBObjectStoreParameters): unknown;
        },
        oldVersion: number,
      ) => void)
    | undefined;
}): Promise<StorageResult<FileStore>> {
  const opened = await openFasDatabase({
    namespace: options.namespace,
    suffix: ':files',
    version: options.version ?? 1,
    stores: [METADATA, PAYLOADS],
    upgrade: options.upgrade,
  });
  if (!opened.ok) return opened;
  const database = opened.value;
  return {
    ok: true,
    value: {
      namespace: options.namespace,
      database,
      close() {
        database.close();
      },
    },
  };
}

type FileTransaction = IDBPTransaction<unknown, [string, string], 'readwrite'>;

async function bytesOf(payload: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return new Uint8Array(await payload.arrayBuffer());
}

function metadataError(metadata: FileMetadata): string | undefined {
  if (typeof metadata.id !== 'string' || metadata.id.length === 0 || metadata.id.length > 128) {
    return 'File id must be 1-128 characters.';
  }
  if (metadata.id.includes('\0')) return 'File id is not valid.';
  if (typeof metadata.name !== 'string' || typeof metadata.contentType !== 'string') {
    return 'File name and content type must be strings.';
  }
  if (typeof metadata.revision !== 'number' || typeof metadata.updatedAt !== 'number') {
    return 'File revision and updatedAt must be numbers.';
  }
  return undefined;
}

export async function putFile<M extends FileMetadata>(
  store: FileStore,
  input: {
    metadata: M;
    payload: Blob | ArrayBuffer | Uint8Array;
    /**
     * Called only when this id is already stored. Return the record to commit,
     * with the same id, or null to leave the stored file untouched.
     */
    resolveConflict?:
      | ((local: StoredFile<M>, incoming: StoredFile<M>) => StoredFile<M> | null)
      | undefined;
  },
): Promise<StorageResult<M>> {
  const invalid = metadataError(input.metadata);
  if (invalid) return failure('validation', invalid);
  let payload: Uint8Array;
  try {
    payload = await bytesOf(input.payload);
  } catch (error) {
    return failure('validation', error instanceof Error ? error.message : 'Unreadable payload.');
  }
  const settled = await startTransaction(
    () => store.database.transaction([METADATA, PAYLOADS], 'readwrite'),
    async (tx) => writeFile(tx, input.metadata, payload, input.resolveConflict),
  );
  if (!settled.ok) return settled;
  if (settled.value.type === 'conflict') {
    return failure('conflict', 'A file with this id already exists.');
  }
  if (settled.value.type === 'rejected') return failure('validation', settled.value.detail);
  return { ok: true, value: settled.value.metadata };
}

async function writeFile<M extends FileMetadata>(
  tx: FileTransaction,
  metadata: M,
  payload: Uint8Array,
  resolveConflict:
    | ((local: StoredFile<M>, incoming: StoredFile<M>) => StoredFile<M> | null)
    | undefined,
): Promise<
  { type: 'written'; metadata: M } | { type: 'conflict' } | { type: 'rejected'; detail: string }
> {
  const metaStore = tx.objectStore(METADATA);
  const payloadStore = tx.objectStore(PAYLOADS);
  const originalId = metadata.id;
  const existing = (await metaStore.get(originalId)) as M | undefined;
  let nextMetadata = { ...metadata, byteLength: payload.byteLength };
  let nextPayload = payload;
  if (existing !== undefined) {
    if (!resolveConflict) return { type: 'conflict' };
    const storedPayload = (await payloadStore.get(metadata.id)) as Uint8Array | undefined;
    const local: StoredFile<M> = {
      metadata: existing,
      payload: storedPayload ?? new Uint8Array(),
    };
    const incoming: StoredFile<M> = { metadata: nextMetadata, payload: nextPayload };
    let resolved: StoredFile<M> | null;
    try {
      resolved = resolveConflict(local, incoming);
    } catch (error) {
      return {
        type: 'rejected',
        detail: error instanceof Error ? error.message : 'Conflict policy failed.',
      };
    }
    if (!resolved) return { type: 'conflict' };
    if (resolved.metadata.id !== originalId) {
      return { type: 'rejected', detail: 'Conflict policy must preserve the file id.' };
    }
    const resolvedError = metadataError(resolved.metadata);
    if (resolvedError) return { type: 'rejected', detail: resolvedError };
    nextPayload = resolved.payload;
    nextMetadata = { ...resolved.metadata, byteLength: nextPayload.byteLength };
  }
  await metaStore.put(nextMetadata, nextMetadata.id);
  await payloadStore.put(nextPayload, nextMetadata.id);
  return { type: 'written', metadata: nextMetadata };
}

export async function getFile<M extends FileMetadata>(
  store: FileStore,
  id: string,
): Promise<StorageResult<StoredFile<M> | undefined>> {
  return startTransaction(
    () => store.database.transaction([METADATA, PAYLOADS], 'readonly'),
    async (tx) => {
      const metadata = (await tx.objectStore(METADATA).get(id)) as M | undefined;
      if (metadata === undefined) return undefined;
      const payload = (await tx.objectStore(PAYLOADS).get(id)) as Uint8Array | undefined;
      if (payload === undefined) {
        throw new DOMException('File payload is missing.', 'DataError');
      }
      return { metadata, payload };
    },
  );
}

export async function getFileMetadata<M extends FileMetadata>(
  store: FileStore,
  id: string,
): Promise<StorageResult<M | undefined>> {
  return startTransaction(
    () => store.database.transaction(METADATA, 'readonly'),
    async (tx) => {
      return (await tx.store.get(id)) as M | undefined;
    },
  );
}

export async function listFiles<M extends FileMetadata>(
  store: FileStore,
): Promise<StorageResult<M[]>> {
  return startTransaction(
    () => store.database.transaction(METADATA, 'readonly'),
    async (tx) => {
      return (await tx.store.getAll()) as M[];
    },
  );
}
