import type { Auth } from './auth.js';

/**
 * Per-user key-value store, scoped to (appId, userId).
 *
 * Limits (enforced server-side):
 * - max 1MB total per user
 * - max 100 keys per user
 * - max 64KB per value
 */
export class Kv {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`kv.get failed: ${res.status}`);
    return (await res.json()) as T;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    const res = await this.request('PUT', key, JSON.stringify(value));
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`kv.set failed (${res.status}): ${text}`);
    }
  }

  async delete(key: string): Promise<void> {
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
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
  }
}
