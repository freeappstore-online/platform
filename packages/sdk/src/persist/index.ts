/**
 * Device-local persistence helpers.
 *
 * Data written here stays on this origin on this device. It is wiped when the
 * user clears site data, and it is not a backup.
 *
 * Account-backed and shared data use different APIs:
 * - Private account: `fas.kv` (the signed-in user's keys for this app, on the server).
 * - Public shared: `fas.collections` (public read, owner writes).
 * - Room fan-out: `fas.rooms` (ephemeral; not an access-control list).
 *
 * A failed save returns `{ ok: false, reason }` and must not be presented as
 * saved. Corrupt preference JSON and unreadable records are left in place.
 * `watchPreference` reports that another context changed a key. It does not
 * merge and it does not resolve conflicts. File conflicts use the
 * app-supplied `resolveConflict` policy.
 */
export { getCapability, installCapability, type StorageCapability } from './capability.js';
export type { StoreMigration } from './database.js';
export type { FileMetadata, FileStore, StoredFile } from './file-store.js';
export {
  getFile,
  getFileMetadata,
  listFiles,
  openFileStore,
  putFile,
} from './file-store.js';
export type { LocalStore, OpenStoreOptions, RecordTransaction } from './idb-store.js';
export {
  deleteRecord,
  getRecord,
  openStore,
  putRecord,
  withTransaction,
} from './idb-store.js';
export type { PreferenceNotice } from './prefs.js';
export {
  getPreference,
  preferenceKey,
  removePreference,
  setPreference,
  watchPreference,
} from './prefs.js';
export type { StorageFailure, StorageResult, Validator } from './status.js';
