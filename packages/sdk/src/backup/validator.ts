import {
  type BackupEnvelope,
  type BackupPreview,
  type BackupResult,
  backupFailure,
  byteLengthOf,
  checksumSubject,
  readEnvelopeFields,
  resolveBackupLimit,
  sha256Hex,
} from './envelope.js';

/**
 * App-owned schema. The SDK calls these hooks and does not invent a record model.
 * `migrate` and `validate` must be pure: they must not write preferences or IndexedDB.
 */
export interface BackupSchema<T> {
  /** Envelope versions this app accepts before or after migration. */
  supportedVersions: readonly number[];
  /**
   * Version `validate` expects. Defaults to the greatest entry in
   * `supportedVersions`. Older supported versions go through `migrate` first.
   */
  currentVersion?: number;
  validate: (data: unknown) => data is T;
  migrate?: ((input: { version: number; data: unknown }) => T | Promise<T>) | undefined;
  /** Counts shown before any replacement. Keys are app-defined collection names. */
  counts: (data: T) => Record<string, number>;
}

export interface BackupInspection<T> {
  preview: BackupPreview;
  data: T;
  envelope: BackupEnvelope<unknown>;
}

function schemaVersion<T>(schema: BackupSchema<T>): BackupResult<number> {
  const supported = schema.supportedVersions;
  if (
    !Array.isArray(supported) ||
    supported.length === 0 ||
    supported.some((version) => !Number.isInteger(version) || version < 1)
  ) {
    return backupFailure('validation', 'Backup schema is not valid.');
  }
  const current = schema.currentVersion ?? Math.max(...supported);
  if (!supported.includes(current)) {
    return backupFailure('validation', 'Backup schema is not valid.');
  }
  return { ok: true, value: current };
}

function readCounts(value: unknown): BackupResult<Record<string, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return backupFailure('validation', 'Backup preview counts are not valid.');
  }
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
      return backupFailure('validation', 'Backup preview counts are not valid.');
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 1_000_000) {
      return backupFailure('validation', 'Backup preview counts are not valid.');
    }
    counts[key] = count;
  }
  return { ok: true, value: counts };
}

/**
 * Validate a backup and return counts without writing.
 * Call this before `importBackup` so the user can see what replacement would touch.
 */
export async function previewBackup<T>(
  raw: unknown,
  schema: BackupSchema<T>,
  maxBytes?: number,
): Promise<BackupResult<BackupInspection<T>>> {
  const limit = resolveBackupLimit(maxBytes);
  if (!limit.ok) return limit;

  let encoded = '';
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    if (byteLengthOf(raw) > limit.value) {
      return backupFailure('oversized', 'Backup exceeds the size limit.');
    }
    encoded = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return backupFailure('validation', 'Malformed backup.');
    }
  } else {
    try {
      encoded = JSON.stringify(raw);
    } catch {
      return backupFailure('validation', 'Malformed backup.');
    }
    if (typeof encoded !== 'string') return backupFailure('validation', 'Malformed backup.');
    if (byteLengthOf(encoded) > limit.value) {
      return backupFailure('oversized', 'Backup exceeds the size limit.');
    }
  }

  const fields = readEnvelopeFields(parsed);
  if (!fields.ok) return fields;
  const envelope = fields.value;
  const subject = checksumSubject(envelope);
  if (!subject) return backupFailure('validation', 'Malformed backup.');
  const digest = await sha256Hex(subject);
  if (!digest.ok) return digest;
  if (digest.value !== envelope.checksum) {
    return backupFailure('corrupt', 'Backup checksum does not match.');
  }

  const current = schemaVersion(schema);
  if (!current.ok) return current;
  if (!schema.supportedVersions.includes(envelope.version)) {
    return backupFailure('unsupported', `Unsupported backup version ${envelope.version}.`);
  }

  let data: T;
  try {
    if (envelope.version === current.value) {
      if (!schema.validate(envelope.data)) {
        return backupFailure('validation', 'Backup data did not match the app schema.');
      }
      data = envelope.data;
    } else if (!schema.migrate) {
      return backupFailure('validation', 'This backup version needs an app migration.');
    } else {
      data = await schema.migrate({ version: envelope.version, data: envelope.data });
      if (!schema.validate(data)) {
        return backupFailure('validation', 'Migrated backup did not match the app schema.');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup migration failed.';
    return backupFailure('validation', message);
  }

  let counts: Record<string, number>;
  try {
    const counted = readCounts(schema.counts(data));
    if (!counted.ok) return counted;
    counts = counted.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup preview counts failed.';
    return backupFailure('validation', message);
  }

  return {
    ok: true,
    value: {
      envelope,
      data,
      preview: {
        version: envelope.version,
        appId: envelope.appId,
        exportedAt: envelope.exportedAt,
        byteLength: byteLengthOf(encoded),
        counts,
      },
    },
  };
}
