import { type IDBPDatabase, openDB } from 'idb';
import {
  checkSegment,
  classifyStorageError,
  errorMessage,
  failure,
  type StorageResult,
} from './status.js';

/** Enough of an IndexedDB database to create stores during a version upgrade. */
export interface StoreMigration {
  objectStoreNames: DOMStringList;
  createObjectStore(name: string, options?: IDBObjectStoreParameters): unknown;
}

export interface OpenDatabaseOptions {
  /** App segment. The database name is `fas:<namespace>` plus an optional suffix. */
  namespace: string;
  /** Extra name segment such as `:files`. Included in the database name. */
  suffix?: string;
  version: number;
  /** Object stores that must exist. Missing stores are created before `upgrade`. */
  stores: readonly string[];
  upgrade?: ((database: StoreMigration, oldVersion: number) => void) | undefined;
}

export function databaseName(namespace: string, suffix = ''): StorageResult<string> {
  const checked = checkSegment(namespace, 'Namespace');
  if (!checked.ok) return checked;
  return { ok: true, value: `fas:${checked.value}${suffix}` };
}

export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export async function openFasDatabase(
  options: OpenDatabaseOptions,
): Promise<StorageResult<IDBPDatabase>> {
  if (!idbAvailable()) return failure('unavailable', 'IndexedDB is not available.');
  const name = databaseName(options.namespace, options.suffix ?? '');
  if (!name.ok) return name;
  if (!Number.isInteger(options.version) || options.version < 1) {
    return failure('validation', 'Version must be an integer >= 1.');
  }
  let database: IDBPDatabase | undefined;
  try {
    database = await openDB(name.value, options.version, {
      upgrade(db, oldVersion) {
        for (const store of options.stores) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
        options.upgrade?.(db, oldVersion);
      },
      blocking() {
        // This connection is holding a version the caller wants to upgrade. Close
        // it so the upgrade can proceed. Closing does not delete data.
        database?.close();
      },
    });
    return { ok: true, value: database };
  } catch (error) {
    return failure(classifyStorageError(error), errorMessage(error));
  }
}
