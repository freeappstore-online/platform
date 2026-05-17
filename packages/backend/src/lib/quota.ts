export interface KvUsage {
  /** Total bytes across all keys for this (app, user). */
  totalBytes: number;
  /** Number of keys for this (app, user). */
  keyCount: number;
  /** Bytes currently held by the key being written (0 if the key doesn't exist). */
  existingKeyBytes: number;
  /**
   * Whether the key being written already exists. We track this explicitly
   * rather than inferring from existingKeyBytes — a 0-byte existing value
   * would otherwise be misclassified as a new key, breaking the key-count
   * limit accounting.
   */
  keyExists: boolean;
}

export interface KvLimits {
  maxValueBytes: number;
  maxTotalBytesPerUser: number;
  maxKeysPerUser: number;
}

export type QuotaCheck = { ok: true } | { ok: false; reason: string };

/**
 * Projects the quota state after a hypothetical write of `newValueBytes` to
 * an existing or new key, and returns whether it would breach any limit.
 */
export function checkKvWrite(usage: KvUsage, newValueBytes: number, limits: KvLimits): QuotaCheck {
  if (newValueBytes > limits.maxValueBytes) {
    return { ok: false, reason: `value exceeds ${limits.maxValueBytes} bytes` };
  }
  const projectedTotal = usage.totalBytes - usage.existingKeyBytes + newValueBytes;
  if (projectedTotal > limits.maxTotalBytesPerUser) {
    return { ok: false, reason: 'per-user kv quota exceeded' };
  }
  if (!usage.keyExists && usage.keyCount >= limits.maxKeysPerUser) {
    return {
      ok: false,
      reason: `per-user key count limit (${limits.maxKeysPerUser}) exceeded`,
    };
  }
  return { ok: true };
}

export const KV_LIMITS: KvLimits = {
  maxValueBytes: 64 * 1024,
  maxTotalBytesPerUser: 1024 * 1024,
  maxKeysPerUser: 100,
};
