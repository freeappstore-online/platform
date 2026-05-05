import type { Auth } from './auth.js';

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
    private readonly auth: Auth,
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    assertValidKey(key);
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`kv.get failed: ${res.status}`);
    return (await res.json()) as T;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    assertValidKey(key);
    // JSON.stringify(undefined) returns undefined, which would store an empty
    // body and break later get() calls. Reject up front instead.
    if (value === undefined) {
      throw new Error('kv.set: value is undefined. Use kv.delete(key) to remove a key.');
    }
    const res = await this.request('PUT', key, JSON.stringify(value));
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`kv.set failed (${res.status}): ${text}`);
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) {
      throw new Error(`kv.delete failed: ${res.status}`);
    }
  }

  private request(method: string, key: string, body?: string): Promise<Response> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/kv/${encodeURIComponent(key)}`,
      this.apiBase,
    );
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    return fetch(url, init);
  }
}
