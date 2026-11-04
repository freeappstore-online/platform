import type { IDBPDatabase } from 'idb';
import { openFasDatabase, type StoreMigration } from './database.js';
import {
  checkSegment,
  failure,
  type StorageResult,
  startTransaction,
  type Validator,
} from './status.js';

/**
 * Recommended IndexedDB integration.
 *
 * The caller owns the record shape, the validator, and the version upgrade.
 * `putRecord`, `deleteRecord`, and `withTransaction` resolve successfully only
 * after the IndexedDB transaction completes (`tx.done`). There is no success
 * toast here. A failed transaction leaves the previous record in place.
 *
 * Device-only. This database is not copied to `fas.kv`.
 */

const RECORDS = 'records';

export interface LocalStore {
  readonly namespace: string;
  readonly database: IDBPDatabase;
  close(): void;
}

export interface OpenStoreOptions {
  namespace: string;
  /** Integer schema version, starting at 1. */
  version: number;
  /**
   * Versioned migration. `oldVersion` is 0 the first time the database is
   * created. The `records` store already exists. Do not delete stores that
   * hold data you still need.
   */
  upgrade?: ((database: StoreMigration, oldVersion: number) => void) | undefined;
}

export async function openStore(options: OpenStoreOptions): Promise<StorageResult<LocalStore>> {
  const opened = await openFasDatabase({
    namespace: options.namespace,
    version: options.version,
    stores: [RECORDS],
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

function recordKey(key: string): StorageResult<string> {
  return checkSegment(key, 'Key');
}

export async function getRecord<T>(
  store: LocalStore,
  key: string,
  validate?: Validator<T>,
): Promise<StorageResult<T | undefined>> {
  const checked = recordKey(key);
  if (!checked.ok) return checked;
  const settled = await startTransaction(
    () => store.database.transaction(RECORDS, 'readonly'),
    async (tx) => {
      // idb resolves a missing key to undefined. The untyped database schema
      // types that result as any, so the cast restores the caller's record type.
      const raw = (await tx.store.get(checked.value)) as T | undefined;
      return raw;
    },
  );
  if (!settled.ok) return settled;
  if (settled.value === undefined) return { ok: true, value: undefined };
  if (validate && !validate(settled.value)) {
    return failure('validation', 'Stored record did not match the validator.');
  }
  return { ok: true, value: settled.value };
}

export async function putRecord<T>(
  store: LocalStore,
  key: string,
  value: T,
  validate?: Validator<T>,
): Promise<StorageResult<T>> {
  const checked = recordKey(key);
  if (!checked.ok) return checked;
  if (validate && !validate(value)) {
    return failure('validation', 'Value did not match the validator.');
  }
  return startTransaction(
    () => store.database.transaction(RECORDS, 'readwrite'),
    async (tx) => {
      await tx.store.put(value, checked.value);
      return value;
    },
  );
}

export async function deleteRecord(store: LocalStore, key: string): Promise<StorageResult<true>> {
  const checked = recordKey(key);
  if (!checked.ok) return checked;
  return startTransaction(
    () => store.database.transaction(RECORDS, 'readwrite'),
    async (tx) => {
      await tx.store.delete(checked.value);
      return true as const;
    },
  );
}

export interface RecordTransaction {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  abort(): void;
}

/**
 * Run several record operations in one transaction.
 *
 * The result is `{ ok: true }` only after the transaction commits. `put`
 * inside the callback resolves when that request succeeds, which can be
 * earlier; do not treat that request promise as a committed save.
 */
export async function withTransaction<T>(
  store: LocalStore,
  mode: 'readonly' | 'readwrite',
  run: (tx: RecordTransaction) => Promise<T> | T,
): Promise<StorageResult<T>> {
  // Split the mode so put and delete keep their receiver. A union mode types
  // those methods as `function | undefined`, and detaching them drops `this`.
  if (mode === 'readonly') {
    return startTransaction(
      () => store.database.transaction(RECORDS, 'readonly'),
      async (tx) =>
        run({
          get: (key) => tx.store.get(key),
          put: async () => {
            throw new DOMException('This transaction is read-only.', 'ReadOnlyError');
          },
          delete: async () => {
            throw new DOMException('This transaction is read-only.', 'ReadOnlyError');
          },
          abort: () => tx.abort(),
        }),
    );
  }
  return startTransaction(
    () => store.database.transaction(RECORDS, 'readwrite'),
    async (tx) =>
      run({
        get: (key) => tx.store.get(key),
        put: async (key, value) => {
          await tx.store.put(value, key);
        },
        delete: async (key) => {
          await tx.store.delete(key);
        },
        abort: () => tx.abort(),
      }),
  );
}
