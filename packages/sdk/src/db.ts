import type { Auth } from './auth.js';

export interface QueryOptions {
  owner?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
}

export interface QueryResult<T> {
  documents: (T & { id: string })[];
  total: number;
}

/** Document database — organize data into named collections. */
export class Db {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /** Get a collection handle for the given name. */
  collection(name: string): Collection {
    return new Collection(this.appId, name, this.apiBase, this.auth);
  }
}

/** A named collection of JSON documents. */
export class Collection {
  constructor(
    private readonly appId: string,
    private readonly name: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /** Create a new document. Auth required. Returns the document with its generated `id`. */
  async create<T extends Record<string, unknown>>(doc: T): Promise<T & { id: string }> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/db/${encodeURIComponent(this.name)}`,
      this.apiBase,
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(doc),
    });
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`db.create failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T & { id: string };
  }

  /** Get a document by ID. Returns null if not found. Public read. */
  async get<T = Record<string, unknown>>(id: string): Promise<(T & { id: string }) | null> {
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/db/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      this.apiBase,
    );
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`db.get failed: ${response.status}`);
    return (await response.json()) as T & { id: string };
  }

  /** Query documents with optional filtering and pagination. Public read. */
  async query<T = Record<string, unknown>>(opts?: QueryOptions): Promise<QueryResult<T>> {
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/db/${encodeURIComponent(this.name)}`,
      this.apiBase,
    );
    if (opts?.owner) url.searchParams.set('owner', opts.owner);
    if (opts?.limit !== undefined) url.searchParams.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) url.searchParams.set('offset', String(opts.offset));
    if (opts?.orderBy) url.searchParams.set('orderBy', opts.orderBy);
    if (opts?.order) url.searchParams.set('order', opts.order);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`db.query failed: ${response.status}`);
    return (await response.json()) as QueryResult<T>;
  }

  /** Update a document by merging the patch into the existing data. Auth required, owner only. */
  async update<T extends Record<string, unknown>>(id: string, patch: Partial<T>): Promise<T & { id: string }> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/db/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      this.apiBase,
    );
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`db.update failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T & { id: string };
  }

  /** Delete a document. Auth required, owner only. */
  async delete(id: string): Promise<void> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/db/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      this.apiBase,
    );
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`db.delete failed (${response.status}): ${text}`);
    }
  }
}
