/**
 * Validated backup, import, and browser file export on top of device-local data.
 *
 * The app owns the payload, the schema, and the merge policy. These helpers
 * validate a versioned envelope, show counts before replacement, and roll a
 * failed import back to a snapshot. They do not write `fas.kv`.
 */
export {
  BACKUP_CAPABILITY_NAME,
  getBackupCapability,
  probeBackupCapability,
  registerBackupCapability,
} from './capability.js';
export {
  ABSOLUTE_BACKUP_MAX_BYTES,
  BACKUP_ENVELOPE_VERSION,
  BACKUP_FORMAT,
  type BackupEnvelope,
  type BackupFailure,
  type BackupPreview,
  type BackupResult,
  DEFAULT_BACKUP_MAX_BYTES,
  type JsonSerialized,
} from './envelope.js';
export {
  type BackupExampleHandlers,
  type BackupExampleView,
  mountBackupExample,
} from './example-ui.js';
export {
  backupFilename,
  detectTransferSupport,
  type ExportBackupOptions,
  exportBackup,
  type ShareOrDownloadOptions,
  shareOrDownloadBackup,
  type TransferHandle,
  type TransferSupport,
} from './export.js';
export { type ImportBackupOptions, type ImportMode, importBackup } from './import.js';
export { type BackupInspection, type BackupSchema, previewBackup } from './validator.js';
