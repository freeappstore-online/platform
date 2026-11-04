import { getCapability, installCapability, type StorageCapability } from '../persist/capability.js';
import { failure, type StorageResult } from '../persist/status.js';

/**
 * Name passed to `installCapability`.
 *
 * Registering or getting this capability does not read or delete preferences,
 * IndexedDB databases, or backup files. There is no removal helper. Deleting a
 * generated capability module does not delete app data.
 */
export const BACKUP_CAPABILITY_NAME = 'backup';

export function probeBackupCapability(): StorageResult<true> {
  try {
    if (typeof TextEncoder !== 'function' || typeof JSON.stringify !== 'function') {
      return failure('unavailable', 'Backup helpers are not available.');
    }
    return { ok: true, value: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup helpers are not available.';
    return failure('unavailable', message);
  }
}

/** Install the backup capability at startup or the first time the feature runs. */
export function registerBackupCapability(): StorageResult<StorageCapability> {
  return installCapability(BACKUP_CAPABILITY_NAME, () => ({ probe: probeBackupCapability }));
}

export function getBackupCapability(): StorageResult<StorageCapability> {
  return getCapability(BACKUP_CAPABILITY_NAME);
}
