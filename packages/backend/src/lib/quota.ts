export interface KvUsage {
  /** Total bytes across all keys for this (app, user). */
  totalBytes: number;
  /** Number of keys for this (app, user). */
  keyCount: number;
  /** Bytes currently held by the key being written (0 if it's a new key). */
  existingKeyBytes: number;
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
export function checkKvWrite(
  usage: KvUsage,
  newValueBytes: number,
  limits: KvLimits,
): QuotaCheck {
  if (newValueBytes > limits.maxValueBytes) {
    return { ok: false, reason: `value exceeds ${limits.maxValueBytes} bytes` };
  }
  const projectedTotal = usage.totalBytes - usage.existingKeyBytes + newValueBytes;
  if (projectedTotal > limits.maxTotalBytesPerUser) {
    return { ok: false, reason: 'per-user kv quota exceeded' };
  }
  const isNewKey = usage.existingKeyBytes === 0;
  if (isNewKey && usage.keyCount >= limits.maxKeysPerUser) {
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
