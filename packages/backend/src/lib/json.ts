// Tolerant readers for JSON stored in D1 TEXT columns: malformed or
// wrong-shaped values come back empty instead of throwing.

/** A JSON object, or null for anything else (non-string, malformed, array, primitive). */
export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A JSON array, or [] for anything else. */
export function parseJsonArray(value: unknown): unknown[] {
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
