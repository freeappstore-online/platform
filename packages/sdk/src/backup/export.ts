import { checkSegment } from '../persist/status.js';
import {
  BACKUP_ENVELOPE_VERSION,
  BACKUP_FORMAT,
  type BackupEnvelope,
  type BackupResult,
  backupFailure,
  byteLengthOf,
  checksumSubject,
  detachJson,
  resolveBackupLimit,
  sha256Hex,
} from './envelope.js';

export interface ExportBackupOptions<T> {
  appId: string;
  /** App-owned snapshot. This function does not read IndexedDB or localStorage. */
  data: T;
  /** Defaults to `BACKUP_ENVELOPE_VERSION`. */
  version?: number;
  /** Defaults to the current time. */
  exportedAt?: string;
  maxBytes?: number;
}

export interface TransferSupport {
  share: boolean;
  download: boolean;
}

export interface TransferHandle {
  method: 'share' | 'download' | 'text';
  filename: string;
  /** Set for `download` until `release` revokes it. */
  objectUrl?: string;
  /**
   * Set when the browser cannot share a file or start a download.
   * Show this text so the user can copy the backup.
   */
  text?: string;
  /** Revoke a download object URL. Safe to call more than once, including after the automatic revoke. */
  release(): void;
}

export interface ShareOrDownloadOptions {
  envelope: BackupEnvelope<unknown>;
  filename?: string;
  signal?: AbortSignal | undefined;
  share?: ((data: ShareData) => Promise<void>) | undefined;
  canShare?: ((data: ShareData) => boolean) | undefined;
  createObjectURL?: ((blob: Blob) => string) | undefined;
  revokeObjectURL?: ((url: string) => void) | undefined;
  /** `null` forces the text fallback. Omit to use the page document when it exists. */
  document?: Document | null;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Backup export failed.';
}

/** Export a detached JSON snapshot; returned data uses JsonSerialized<T>. */
export async function exportBackup<T>(
  options: ExportBackupOptions<T>,
): Promise<BackupResult<BackupEnvelope<T>>> {
  const appId = checkSegment(options.appId, 'App id');
  if (!appId.ok) return backupFailure('validation', appId.detail ?? 'App id is not valid.');
  const version = options.version ?? BACKUP_ENVELOPE_VERSION;
  if (!Number.isInteger(version) || version < 1) {
    return backupFailure('validation', 'Version must be an integer >= 1.');
  }
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(exportedAt))) {
    return backupFailure('validation', 'exportedAt is not a valid time.');
  }
  // Hash the detached JSON snapshot. A live Date canonicalizes as {} but
  // JSON.stringify emits an ISO string, so the checksum must cover the bytes
  // a later parse will see. The returned payload is that snapshot.
  const snapshot = detachJson(options.data);
  if (!snapshot.ok) return snapshot;
  const data = snapshot.value;
  const subject = checksumSubject({ version, appId: appId.value, exportedAt, data });
  if (!subject) return backupFailure('validation', 'Backup data is not JSON.');
  const digest = await sha256Hex(subject);
  if (!digest.ok) return digest;
  const envelope: BackupEnvelope<T> = {
    format: BACKUP_FORMAT,
    version,
    exportedAt,
    appId: appId.value,
    data,
    checksum: digest.value,
  };
  const limit = resolveBackupLimit(options.maxBytes);
  if (!limit.ok) return limit;
  const encoded = JSON.stringify(envelope);
  if (byteLengthOf(encoded) > limit.value) {
    return backupFailure('oversized', 'Backup exceeds the size limit.');
  }
  return { ok: true, value: envelope };
}

export function backupFilename(appId: string, exportedAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(exportedAt) ? exportedAt.slice(0, 10) : 'undated';
  const safe = appId.replace(/[^A-Za-z0-9._-]/g, '') || 'app';
  return `fas-backup-${safe}-${day}.json`;
}

export function detectTransferSupport(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): TransferSupport {
  const share = !!nav && typeof nav.share === 'function' && typeof nav.canShare === 'function';
  const download = !!doc && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  return { share, download };
}

/**
 * Share a backup file when the browser can, otherwise download it.
 * When neither API exists, return the JSON text. `release` always revokes an
 * object URL this call created. A user dismissing the share sheet is `cancelled`
 * and does not also start a download.
 */
export async function shareOrDownloadBackup(
  options: ShareOrDownloadOptions,
): Promise<BackupResult<TransferHandle>> {
  if (options.signal?.aborted) return backupFailure('cancelled', 'Export cancelled.');
  let json: string;
  try {
    json = JSON.stringify(options.envelope);
  } catch {
    return backupFailure('validation', 'Backup data is not JSON.');
  }
  if (typeof json !== 'string') return backupFailure('validation', 'Backup data is not JSON.');
  const filename =
    options.filename ?? backupFilename(options.envelope.appId, options.envelope.exportedAt);
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    return backupFailure('validation', 'Backup filename is not valid.');
  }

  const file =
    typeof File === 'function'
      ? new File([json], filename, { type: 'application/json' })
      : undefined;
  const shareData: ShareData = file
    ? { files: [file], title: filename }
    : { title: filename, text: json };
  const browser = typeof navigator === 'undefined' ? undefined : navigator;
  const canShare = options.canShare ?? ((data: ShareData) => browser?.canShare?.(data) ?? false);
  const share =
    options.share ??
    (async (data: ShareData) => {
      if (!browser?.share) throw new Error('Share is not available.');
      await browser.share(data);
    });
  let shareSupported = false;
  try {
    shareSupported = canShare(shareData) && !!file;
  } catch {
    shareSupported = false;
  }
  if (shareSupported) {
    try {
      await share(shareData);
      return { ok: true, value: { method: 'share', filename, release() {} } };
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return backupFailure('cancelled', 'Export cancelled.');
      }
      // A rejected share that is not a user cancel falls through to download.
    }
  }
  return downloadOrText(options, json, filename);
}

function downloadOrText(
  options: ShareOrDownloadOptions,
  json: string,
  filename: string,
): BackupResult<TransferHandle> {
  const doc =
    options.document === undefined
      ? typeof document === 'undefined'
        ? undefined
        : document
      : (options.document ?? undefined);
  const create = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revoke = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  if (!doc) {
    return {
      ok: true,
      value: { method: 'text', filename, text: json, release() {} },
    };
  }
  let objectUrl: string;
  try {
    objectUrl = create(new Blob([json], { type: 'application/json' }));
  } catch {
    return {
      ok: true,
      value: { method: 'text', filename, text: json, release() {} },
    };
  }
  if (!objectUrl) {
    return backupFailure('unavailable', 'Object URL was empty.');
  }
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      revoke(objectUrl);
    } catch {
      // Already revoked.
    }
  };
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = doc.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    try {
      anchor?.remove();
    } catch {
      // Continue revoking the object URL even if DOM cleanup throws.
    }
    release();
    return backupFailure('unavailable', errorText(error));
  }
  timer = setTimeout(release, 0);
  const handle: TransferHandle = { method: 'download', filename, objectUrl, release };
  return { ok: true, value: handle };
}
