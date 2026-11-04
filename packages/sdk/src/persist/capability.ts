import {
  checkSegment,
  classifyStorageError,
  errorMessage,
  failure,
  type StorageResult,
} from './status.js';

/**
 * Register a storage capability at startup or the first time a feature runs.
 *
 * Installing again returns the capability already registered and does not call
 * the installer. Installers must not delete databases, preference keys, or
 * edited app data. `getCapability` distinguishes a name that was never
 * registered (`not-installed`) from one that is registered while its store is
 * blocked (`unavailable`, with detail `installed`).
 */

export interface StorageCapability {
  /**
   * Probe the backing store without reading or writing app records.
   * Return `{ ok: false, reason: 'unavailable' }` when storage is blocked.
   */
  probe: () => StorageResult<true>;
}

const installed = new Map<string, StorageCapability>();

export function installCapability(
  name: string,
  installer: () => StorageCapability,
): StorageResult<StorageCapability> {
  const checked = checkSegment(name, 'Capability name');
  if (!checked.ok) return checked;
  const existing = installed.get(checked.value);
  if (existing) return { ok: true, value: existing };
  try {
    const created = installer();
    installed.set(checked.value, created);
    return { ok: true, value: created };
  } catch (error) {
    return failure(classifyStorageError(error), errorMessage(error));
  }
}

export function getCapability(name: string): StorageResult<StorageCapability> {
  const checked = checkSegment(name, 'Capability name');
  if (!checked.ok) return checked;
  const existing = installed.get(checked.value);
  if (!existing) return failure('not-installed');
  try {
    const probe = existing.probe();
    if (!probe.ok) return failure(probe.reason, 'installed');
    return { ok: true, value: existing };
  } catch (error) {
    return failure(classifyStorageError(error), 'installed');
  }
}
