interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
}

export interface Friend {
  userId: string;
  login: string;
  avatarUrl: string | null;
  status: string;
  since: number;
}

export interface FriendSearchResult {
  userId: string;
  login: string;
  avatarUrl: string | null;
  friendStatus: string;
}

export type FriendshipStatus =
  | 'none'
  | 'pending_outgoing'
  | 'pending_incoming'
  | 'accepted'
  | 'blocked_by_you';

/**
 * Platform-level friends. Once two users are friends, every app on
 * FreeAppStore can use that relationship.
 *
 * @example
 *   const friends = await app.friends.list()
 *   const incoming = await app.friends.requests()
 *   await app.friends.request('gh:456')
 *   await app.friends.respond('gh:456', 'accept')
 */
export class Friends {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** List friends by status. Defaults to accepted friends. */
  async list(status?: 'accepted' | 'pending_incoming' | 'pending_outgoing'): Promise<Friend[]> {
    const token = this.auth.token;
    if (!token) return [];
    const qs = status ? `?status=${status}` : '';
    const res = await fetch(`${this.apiBase}/v1/friends${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      this.auth.handleUnauthorized();
      return [];
    }
    if (!res.ok) return [];
    const data = (await res.json()) as { friends: Friend[] };
    return data.friends;
  }

  /** Shortcut: list incoming friend requests. */
  async requests(): Promise<Friend[]> {
    return this.list('pending_incoming');
  }

  /** Send a friend request. Returns status and whether it was auto-accepted (mutual). */
  async request(userId: string): Promise<{ status: string; autoAccepted: boolean }> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const res = await fetch(`${this.apiBase}/v1/friends/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `request failed: ${res.status}`);
    }
    return res.json() as Promise<{ status: string; autoAccepted: boolean }>;
  }

  /** Respond to a friend request or block a user. */
  async respond(userId: string, action: 'accept' | 'decline' | 'block'): Promise<void> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const res = await fetch(`${this.apiBase}/v1/friends/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `respond failed: ${res.status}`);
    }
  }

  /** Remove a friend, cancel outgoing request, or unblock. */
  async remove(userId: string): Promise<void> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const res = await fetch(`${this.apiBase}/v1/friends/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `remove failed: ${res.status}`);
    }
  }

  /** Shortcut: block a user. */
  async block(userId: string): Promise<void> {
    return this.respond(userId, 'block');
  }

  /** Check if a specific user is a friend. */
  async isFriend(userId: string): Promise<boolean> {
    const s = await this.check(userId);
    return s === 'accepted';
  }

  /** Check the friendship status with a specific user. */
  async check(userId: string): Promise<FriendshipStatus> {
    const token = this.auth.token;
    if (!token) return 'none';
    const res = await fetch(`${this.apiBase}/v1/friends/check/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return 'none';
    const data = (await res.json()) as { status: FriendshipStatus };
    return data.status;
  }

  /** Search users by GitHub login. Returns users with their friendship status. */
  async search(query: string): Promise<FriendSearchResult[]> {
    const token = this.auth.token;
    if (!token) return [];
    const res = await fetch(
      `${this.apiBase}/v1/friends/search?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { users: FriendSearchResult[] };
    return data.users;
  }
}
