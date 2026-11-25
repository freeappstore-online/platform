import { authedFetch, type SessionAuth } from './authed-fetch.js';

/**
 * Per-user key-value store, scoped to (appId, userId).
 *
 * Limits (enforced server-side):
 * - max 1MB total per user
 * - max 100 keys per user
 * - max 64KB per value
 *
 * Keys are non-empty strings ≤ 128 chars. We validate client-side so the
 * server doesn't have to deal with edge-case URLs like `/kv/` or absurdly
 * long path segments.
 */
const MAX_KEY_LENGTH = 128;

function assertValidKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('kv key must be a non-empty string.');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`kv key exceeds ${MAX_KEY_LENGTH} chars.`);
  }
}

export class Kv {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: SessionAuth,
  ) {}

  /** List all keys for this user. Optionally filter by prefix. */
  async list(opts?: { prefix?: string; signal?: AbortSignal }): Promise<string[]> {
    const url = new URL(`/v1/apps/${encodeURIComponent(this.appId)}/kv`, this.apiBase);
    if (opts?.prefix) url.searchParams.set('prefix', opts.prefix);
    const listResponse = await authedFetch(
      this.auth,
      url,
      opts?.signal ? { signal: opts.signal } : {},
    );
    if (!listResponse.ok) throw new Error(`kv.list failed: ${listResponse.status}`);
    return (await listResponse.json()) as string[];
  }

  /** Fetch multiple keys in parallel. Returns a Map of found key-value pairs (skips failures and missing keys). */
  async getMany<T = unknown>(
    keys: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<Map<string, T>> {
    for (const key of keys) assertValidKey(key);
    const results = new Map<string, T>();
    const settled = await Promise.allSettled(
      keys.map(async (key) => {
        const stored = await this.get<T>(key, opts);
        if (stored !== null) results.set(key, stored);
      }),
    );
    // If ALL requests failed with auth error, re-throw so callers know
    const allFailed = settled.every((s) => s.status === 'rejected');
    if (allFailed && settled.length > 0) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return results;
  }

  /** Get a value by key. Returns null if not found. */
  async get<T = unknown>(key: string, opts?: { signal?: AbortSignal }): Promise<T | null> {
    assertValidKey(key);
    const getResponse = await this.request('GET', key, undefined, opts?.signal);
    if (getResponse.status === 404) return null;
    if (!getResponse.ok) throw new Error(`kv.get failed: ${getResponse.status}`);
    return (await getResponse.json()) as T;
  }

  /** Store a JSON-serializable value under the given key. */
  async set<T = unknown>(key: string, value: T, opts?: { signal?: AbortSignal }): Promise<void> {
    assertValidKey(key);
    // JSON.stringify(undefined) returns undefined, which would store an empty
    // body and break later get() calls. Reject up front instead.
    if (value === undefined) {
      throw new Error('kv.set: value is undefined. Use kv.delete(key) to remove a key.');
    }
    const setResponse = await this.request('PUT', key, JSON.stringify(value), opts?.signal);
    if (!setResponse.ok) {
      const text = await setResponse.text();
      throw new Error(`kv.set failed (${setResponse.status}): ${text}`);
    }
  }

  /** Delete a key. No-op if the key doesn't exist. */
  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    assertValidKey(key);
    const deleteResponse = await this.request('DELETE', key, undefined, opts?.signal);
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      throw new Error(`kv.delete failed: ${deleteResponse.status}`);
    }
  }

  private async request(
    method: string,
    key: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/kv/${encodeURIComponent(key)}`,
      this.apiBase,
    );
    return authedFetch(this.auth, url, {
      method,
      ...(signal && { signal }),
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body }),
    });
  }
}
