import type { Auth } from './auth.js';

export interface GeoBBox {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  latField?: string;
  lonField?: string;
}

export interface QueryOptions {
  /** Your own user id. Another user's id is refused (403). */
  owner?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
  /** Filter documents by geo bounding box on JSON fields (default: lat/lon). */
  bbox?: GeoBBox;
}

export interface QueryResult<T> {
  documents: (T & { id: string })[];
  total: number;
}

/**
 * Who can read a collection's documents (#467). The server decides: a collection
 * is `'private'` (owner-only) until its app owner marks it shared with
 * `fas db share <collection>`. `'public-read'` states in code that the
 * collection is shared, so readers know other users' documents will be listed.
 * Writes are always owner-only.
 */
export type CollectionVisibility = 'private' | 'public-read';

export interface CollectionOptions {
  visibility: CollectionVisibility;
}

/** Document database — organize data into named collections. */
export class Collections {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /** Select a collection. Without options it is private: you read only your own documents. */
  collection(name: string, options?: CollectionOptions): Collection {
    if (options && options.visibility !== 'private' && options.visibility !== 'public-read') {
      throw new Error("Collection visibility must be 'private' or 'public-read'.");
    }
    return new Collection(
      this.appId,
      name,
      this.apiBase,
      this.auth,
      options?.visibility ?? 'private',
    );
  }
}

/** A named collection of JSON documents. */
export class Collection {
  constructor(
    private readonly appId: string,
    private readonly name: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
    readonly visibility: CollectionVisibility,
  ) {}

  /**
   * GET with the session when signed in: a private collection needs it, and a
   * shared one shows `_owner` only to the document's owner. A 401 on a signed-in
   * read drops the stale session, like a write does.
   */
  private async read(url: URL): Promise<Response> {
    const token = this.auth.token;
    const response = await fetch(
      url,
      token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    );
    if (response.status === 401 && token) this.auth.handleUnauthorized(token);
    return response;
  }

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
      this.auth.handleUnauthorized(token);
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`db.create failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T & { id: string };
  }

  /** Get a document by ID. Returns null if not found (or not yours, in a private collection). */
  async get<T = Record<string, unknown>>(id: string): Promise<(T & { id: string }) | null> {
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/db/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      this.apiBase,
    );
    const response = await this.read(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`db.get failed: ${response.status}`);
    return (await response.json()) as T & { id: string };
  }

  /**
   * Query documents with optional filtering and pagination. A private collection
   * lists only your documents; `owner` can only be your own id.
   */
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
    if (opts?.bbox) {
      url.searchParams.set('lat_min', String(opts.bbox.latMin));
      url.searchParams.set('lat_max', String(opts.bbox.latMax));
      url.searchParams.set('lon_min', String(opts.bbox.lonMin));
      url.searchParams.set('lon_max', String(opts.bbox.lonMax));
      if (opts.bbox.latField) url.searchParams.set('lat_field', opts.bbox.latField);
      if (opts.bbox.lonField) url.searchParams.set('lon_field', opts.bbox.lonField);
    }
    const response = await this.read(url);
    if (!response.ok) throw new Error(`db.query failed: ${response.status}`);
    return (await response.json()) as QueryResult<T>;
  }

  /** Update a document by merging the patch into the existing data. Auth required, owner only. */
  async update<T extends Record<string, unknown>>(
    id: string,
    patch: Partial<T>,
  ): Promise<T & { id: string }> {
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
      this.auth.handleUnauthorized(token);
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
      this.auth.handleUnauthorized(token);
      throw new Error('Not signed in.');
    }
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`db.delete failed (${response.status}): ${text}`);
    }
  }
}
