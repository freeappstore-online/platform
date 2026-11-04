/**
 * Device-local storage results.
 *
 * These helpers never report success before the write is committed, and they
 * never delete unreadable data. Account-backed data is a different API:
 * `fas.kv` stores the signed-in user's keys on the server. Public documents
 * use `fas.collections`. Room messages are ephemeral. None of those are
 * replaced by this module.
 */
export type StorageFailure =
  | 'unavailable'
  | 'corrupt'
  | 'quota'
  | 'validation'
  | 'aborted'
  | 'conflict'
  | 'not-installed';

export type StorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: StorageFailure; detail?: string };

export type Validator<T> = (value: unknown) => value is T;

const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

export function failure(reason: StorageFailure, detail?: string): StorageResult<never> {
  if (detail) return { ok: false, reason, detail };
  return { ok: false, reason };
}

export function checkSegment(value: string, label: string): StorageResult<string> {
  if (!SEGMENT.test(value)) {
    return failure(
      'validation',
      `${label} must be 1-64 characters: letters, digits, ".", "_" or "-".`,
    );
  }
  return { ok: true, value };
}

export function classifyStorageError(error: unknown): StorageFailure {
  const name = error instanceof Error ? error.name : '';
  const code = error instanceof DOMException ? error.code : 0;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22) {
    return 'quota';
  }
  if (name === 'AbortError' || name === 'TransactionInactiveError') return 'aborted';
  if (name === 'DataCloneError') return 'validation';
  if (name === 'DataError') return 'corrupt';
  return 'unavailable';
}

export function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  return undefined;
}

/**
 * Run `work`, then wait until `done` settles. Success is returned only after
 * `done`. A rejection aborts the transaction and does not report success.
 */
export async function settleTransaction<T>(
  done: Promise<void>,
  abort: () => void,
  work: () => Promise<T>,
): Promise<StorageResult<T>> {
  try {
    const value = await work();
    await done;
    return { ok: true, value };
  } catch (error) {
    try {
      abort();
    } catch {
      // Already aborting or finished.
    }
    done.catch(() => undefined);
    return failure(classifyStorageError(error), errorMessage(error));
  }
}
