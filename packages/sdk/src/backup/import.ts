import type { BackupPreview, BackupResult } from './envelope.js';
import { backupFailure } from './envelope.js';
import { type BackupSchema, previewBackup } from './validator.js';

export type ImportMode = 'merge' | 'replace';

export interface ImportBackupOptions<T, S> {
  /** Envelope object or its JSON text. */
  raw: unknown;
  /**
   * Required. There is no default. `merge` and `replace` are both applied by
   * the app's `apply` function; this module does not combine records itself.
   */
  mode: ImportMode;
  schema: BackupSchema<T>;
  maxBytes?: number;
  signal?: AbortSignal | undefined;
  /** Read the current app data. Must not mutate it. */
  snapshot: () => S | Promise<S>;
  /**
   * Write `data` with the app's conflict policy.
   * Throw before publishing a partial write when you can. If a write fails
   * after mutation, `restore` puts `snapshot` back.
   */
  apply: (data: T, mode: ImportMode) => void | Promise<void>;
  /** Put the snapshot back. Called only after `apply` fails or the import is cancelled during apply. */
  restore: (snapshot: S) => void | Promise<void>;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'write failed';
}

function cancelled(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Import is all-or-nothing.
 *
 * Nothing is written until validation, the checksum, the size limit, and an
 * explicit `merge` or `replace` choice have succeeded. `snapshot` runs next.
 * If `apply` throws, or the abort signal is set before `apply` returns, `restore`
 * puts that snapshot back. Success is returned only when `apply` finishes and
 * the signal is still clear.
 *
 * If `restore` also throws, the result is `{ ok: false, reason: 'rollback' }`
 * and the detail says the stored data may be partial. That is the only path
 * that cannot promise the previous bytes; it is never reported as success.
 */
export async function importBackup<T, S>(
  options: ImportBackupOptions<T, S>,
): Promise<BackupResult<BackupPreview>> {
  if (options.mode !== 'merge' && options.mode !== 'replace') {
    return backupFailure('validation', 'Choose merge or replace before import.');
  }
  if (options.signal?.aborted) return backupFailure('cancelled', 'Import cancelled.');

  const inspected = await previewBackup(options.raw, options.schema, options.maxBytes);
  if (!inspected.ok) return inspected;
  if (options.signal?.aborted) return backupFailure('cancelled', 'Import cancelled.');

  let snapshot: S;
  try {
    snapshot = await options.snapshot();
  } catch (error) {
    return backupFailure('unavailable', `Could not read the current data. ${errorText(error)}`);
  }
  if (options.signal?.aborted) return backupFailure('cancelled', 'Import cancelled.');

  try {
    await options.apply(inspected.value.data, options.mode);
  } catch (error) {
    return rollback(snapshot, options.restore, error, options.signal);
  }
  if (options.signal?.aborted) {
    return rollback(
      snapshot,
      options.restore,
      new DOMException('Import cancelled.', 'AbortError'),
      options.signal,
    );
  }
  return { ok: true, value: inspected.value.preview };
}

async function rollback<S>(
  snapshot: S,
  restore: (snapshot: S) => void | Promise<void>,
  error: unknown,
  signal: AbortSignal | undefined,
): Promise<BackupResult<never>> {
  try {
    await restore(snapshot);
  } catch (restoreError) {
    return backupFailure(
      'rollback',
      `Import failed (${errorText(error)}) and rollback failed (${errorText(restoreError)}). Stored data may be partial.`,
    );
  }
  if (cancelled(error, signal)) {
    return backupFailure('cancelled', 'Import cancelled. The previous data was restored.');
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return backupFailure('quota', 'Import hit a storage quota. The previous data was restored.');
  }
  return backupFailure(
    'aborted',
    `Import failed and the previous data was restored. ${errorText(error)}`,
  );
}
