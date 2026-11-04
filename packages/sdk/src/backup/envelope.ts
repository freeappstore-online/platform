import { checkSegment } from '../persist/status.js';

/**
 * A portable copy of app-owned device-local data.
 *
 * The envelope does not interpret record shapes. It is not `fas.kv` and it is
 * not written anywhere until the app calls `importBackup`. `checksum` covers
 * `version`, `appId`, `exportedAt`, and `data` so a truncated or edited payload
 * fails before any store is touched.
 */

export const BACKUP_FORMAT = 'fas-backup' as const;
export const BACKUP_ENVELOPE_VERSION = 1;
/** Default encoded-envelope limit. Callers may set a smaller limit. */
export const DEFAULT_BACKUP_MAX_BYTES = 4 * 1024 * 1024;
/** Hard cap so a caller cannot turn the limit off. */
export const ABSOLUTE_BACKUP_MAX_BYTES = 16 * 1024 * 1024;

const ENVELOPE_KEYS = new Set(['format', 'version', 'exportedAt', 'appId', 'data', 'checksum']);
const CHECKSUM_HEX = /^[a-f0-9]{64}$/;
/**
 * Nested arrays and objects past this depth are rejected. The bound sits well
 * under the engine stack limit so a deep or cyclic payload returns a result
 * instead of throwing.
 */
const MAX_JSON_DEPTH = 1000;

export type BackupFailure =
  | 'unavailable'
  | 'corrupt'
  | 'validation'
  | 'aborted'
  | 'quota'
  | 'unsupported'
  | 'oversized'
  | 'cancelled'
  | 'rollback';

export type BackupResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BackupFailure; detail?: string };

export interface BackupEnvelope<T> {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** ISO-8601 timestamp from the exporting device. */
  exportedAt: string;
  appId: string;
  /** App-owned payload. The SDK does not merge this value. */
  data: T;
  /** Lowercase SHA-256 of the canonical checksum subject. */
  checksum: string;
}

export interface BackupPreview {
  version: number;
  appId: string;
  exportedAt: string;
  byteLength: number;
  /** App-defined collection names and how many records each would affect. */
  counts: Record<string, number>;
}

export function backupFailure(reason: BackupFailure, detail?: string): BackupResult<never> {
  if (detail) return { ok: false, reason, detail };
  return { ok: false, reason };
}

export function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function resolveBackupLimit(maxBytes?: number): BackupResult<number> {
  const limit = maxBytes ?? DEFAULT_BACKUP_MAX_BYTES;
  if (!Number.isInteger(limit) || limit < 1) {
    return backupFailure('validation', 'Size limit must be an integer >= 1.');
  }
  if (limit > ABSOLUTE_BACKUP_MAX_BYTES) {
    return backupFailure(
      'validation',
      `Size limit cannot exceed ${ABSOLUTE_BACKUP_MAX_BYTES} bytes.`,
    );
  }
  return { ok: true, value: limit };
}

/**
 * Stable JSON: object keys are sorted. Non-JSON values, cycles, and nesting
 * deeper than 1000 containers return undefined instead of throwing.
 */
export function canonicalJson(value: unknown): string | undefined {
  try {
    return canonicalize(value, new WeakSet<object>(), 0);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) return undefined;
    throw error;
  }
}

/**
 * Plain JSON copy of `value`. `Date` becomes an ISO string, and the copy
 * shares no objects with the input. Cycles and values the engine cannot
 * serialize return a validation failure.
 */
export function detachJson<T>(value: T): BackupResult<T> {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      return backupFailure('validation', 'Backup data is not JSON.');
    }
    return { ok: true, value: JSON.parse(serialized) as T };
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      return backupFailure('validation', 'Backup data is not JSON.');
    }
    const detail =
      error instanceof Error && error.message ? error.message : 'Backup data is not JSON.';
    return backupFailure('validation', detail);
  }
}

function canonicalize(value: unknown, seen: WeakSet<object>, depth: number): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_JSON_DEPTH) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        if (item === undefined) return undefined;
        const encoded = canonicalize(item, seen, depth + 1);
        if (encoded === undefined) return undefined;
        parts.push(encoded);
      }
      return `[${parts.join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) continue;
      const encoded = canonicalize(child, seen, depth + 1);
      if (encoded === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function checksumSubject(input: {
  version: number;
  appId: string;
  exportedAt: string;
  data: unknown;
}): string | undefined {
  return canonicalJson({
    appId: input.appId,
    data: input.data,
    exportedAt: input.exportedAt,
    version: input.version,
  });
}

export async function sha256Hex(text: string): Promise<BackupResult<string>> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return backupFailure('unavailable', 'SHA-256 is not available in this browser.');
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return { ok: true, value: hex };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SHA-256 failed.';
    return backupFailure('unavailable', message);
  }
}

export function readEnvelopeFields(value: unknown): BackupResult<BackupEnvelope<unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return backupFailure('validation', 'Malformed backup.');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEYS.has(key)) {
      return backupFailure('validation', `Unsupported backup field: ${key}.`);
    }
  }
  if (record.format !== BACKUP_FORMAT) {
    return backupFailure('validation', 'Malformed backup.');
  }
  if (
    typeof record.version !== 'number' ||
    !Number.isInteger(record.version) ||
    record.version < 1
  ) {
    return backupFailure('validation', 'Malformed backup.');
  }
  if (typeof record.exportedAt !== 'string' || !Number.isFinite(Date.parse(record.exportedAt))) {
    return backupFailure('validation', 'Malformed backup.');
  }
  if (typeof record.appId !== 'string') return backupFailure('validation', 'Malformed backup.');
  const appId = checkSegment(record.appId, 'App id');
  if (!appId.ok) return backupFailure('validation', appId.detail ?? 'Malformed backup.');
  if (typeof record.checksum !== 'string' || !CHECKSUM_HEX.test(record.checksum.toLowerCase())) {
    return backupFailure('validation', 'Malformed backup.');
  }
  if (!Object.hasOwn(record, 'data')) return backupFailure('validation', 'Malformed backup.');
  return {
    ok: true,
    value: {
      format: BACKUP_FORMAT,
      version: record.version,
      exportedAt: record.exportedAt,
      appId: appId.value,
      data: record.data,
      checksum: record.checksum.toLowerCase(),
    },
  };
}
