import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Friend, FriendSearchResult, FriendshipStatus } from '../friends.js';
import type { FreeAppStore } from '../index.js';
import { EmptyState, SearchInput, Spinner, Tabs } from './components.js';
import { Avatar } from './core.js';

// ---------------------------------------------------------------------------
// FriendRequestBadge
// ---------------------------------------------------------------------------

export interface FriendRequestBadgeProps {
  app: FreeAppStore;
}

/** Red dot with incoming request count. Renders nothing if 0. Polls every 30s. */
export function FriendRequestBadge({ app }: FriendRequestBadgeProps) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    const poll = () => {
      app.friends
        .requests()
        .then((r) => {
          if (mounted) setCount(r.length);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [app]);

  if (count === 0) return null;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 18,
        height: 18,
        padding: '0 5px',
        borderRadius: '9999px',
        background: '#dc2626',
        color: '#fff',
        fontSize: '0.7rem',
        fontWeight: 700,
        marginLeft: 6,
      }}
    >
      {count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AddFriendButton
// ---------------------------------------------------------------------------

export interface AddFriendButtonProps {
  app: FreeAppStore;
  userId: string;
}

/** Context-aware button: shows Add Friend / Pending / Accept / Friends. */
export function AddFriendButton({ app, userId }: AddFriendButtonProps) {
  const [status, setStatus] = useState<FriendshipStatus | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    app.friends
      .check(userId)
      .then(setStatus)
      .catch(() => setStatus('none'));
  }, [app, userId]);

  const handleAction = async () => {
    setBusy(true);
    try {
      if (status === 'none') {
        const result = await app.friends.request(userId);
        setStatus(result.autoAccepted ? 'accepted' : 'pending_outgoing');
      } else if (status === 'pending_incoming') {
        await app.friends.respond(userId, 'accept');
        setStatus('accepted');
      }
    } catch {}
    setBusy(false);
  };

  if (status === 'loading') return null;

  const config = {
    none: { label: 'Add Friend', color: '#fff', bg: 'var(--accent)', clickable: true },
    pending_outgoing: {
      label: 'Pending',
      color: 'var(--muted)',
      bg: 'var(--panel)',
      clickable: false,
    },
    pending_incoming: { label: 'Accept', color: '#fff', bg: '#16a34a', clickable: true },
    accepted: {
      label: 'Friends',
      color: 'var(--muted)',
      bg: 'var(--panel)',
      clickable: false,
    },
    blocked_by_you: {
      label: 'Blocked',
      color: '#dc2626',
      bg: 'var(--panel)',
      clickable: false,
    },
  } as const;

  const cfg = status in config ? config[status as keyof typeof config] : config.none;

  return (
    <button
      onClick={cfg.clickable ? handleAction : undefined}
      disabled={busy || !cfg.clickable}
      style={{
        padding: '0.3rem 0.7rem',
        borderRadius: 'var(--radius-sm, 0.5rem)',
        border: '1px solid var(--line)',
        background: cfg.bg,
        color: cfg.color,
        fontSize: '0.8rem',
        fontWeight: 600,
        cursor: cfg.clickable ? 'pointer' : 'default',
        fontFamily: 'inherit',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {cfg.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// FriendsList
// ---------------------------------------------------------------------------

export interface FriendsListProps {
  app: FreeAppStore;
  onSelectFriend?: (userId: string) => void;
}

/** Tabbed panel: Friends / Requests / Search. */
export function FriendsList({ app, onSelectFriend }: FriendsListProps) {
  const [tab, setTab] = useState('friends');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<Friend[]>([]);
  const [outgoing, setOutgoing] = useState<Friend[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FriendSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([
      app.friends.list('accepted'),
      app.friends.list('pending_incoming'),
      app.friends.list('pending_outgoing'),
    ])
      .then(([f, i, o]) => {
        setFriends(f);
        setIncoming(i);
        setOutgoing(o);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [app]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSearch = useCallback(
    (q: string) => {
      setSearchQuery(q);
      clearTimeout(debounceRef.current);
      if (q.length < 3) {
        setSearchResults([]);
        return;
      }
      debounceRef.current = setTimeout(() => {
        app.friends
          .search(q)
          .then(setSearchResults)
          .catch(() => {});
      }, 300);
    },
    [app],
  );

  const handleAccept = async (userId: string) => {
    await app.friends.respond(userId, 'accept');
    refresh();
    if (searchQuery.length >= 3) {
      app.friends
        .search(searchQuery)
        .then(setSearchResults)
        .catch(() => {});
    }
  };

  const handleDecline = async (userId: string) => {
    await app.friends.respond(userId, 'decline');
    refresh();
  };

  const handleRequest = async (userId: string) => {
    await app.friends.request(userId);
    refresh();
    // Re-run search to update statuses
    if (searchQuery.length >= 3) {
      app.friends
        .search(searchQuery)
        .then(setSearchResults)
        .catch(() => {});
    }
  };

  const handleRemove = async (userId: string) => {
    await app.friends.remove(userId);
    refresh();
  };

  const tabs = [
    { key: 'friends', label: `Friends${friends.length ? ` (${friends.length})` : ''}` },
    { key: 'requests', label: `Requests${incoming.length ? ` (${incoming.length})` : ''}` },
    { key: 'search', label: 'Search' },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <Tabs
        tabs={tabs}
        active={tab}
        onChange={setTab}
        style={{ marginBottom: '1rem', width: '100%' }}
      />

      {tab === 'friends' && (
        <div>
          {friends.length === 0 ? (
            <EmptyState title="No friends yet" message="Search for users to add them as friends." />
          ) : (
            friends.map((f) => (
              <FriendRow
                key={f.userId}
                login={f.login}
                avatarUrl={f.avatarUrl}
                {...(onSelectFriend ? { onClick: () => onSelectFriend(f.userId) } : {})}
                trailing={
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(f.userId);
                    }}
                    style={smallBtnStyle('#dc2626')}
                  >
                    Remove
                  </button>
                }
              />
            ))
          )}
        </div>
      )}

      {tab === 'requests' && (
        <div>
          {incoming.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <div style={sectionLabel}>Incoming</div>
              {incoming.map((f) => (
                <FriendRow
                  key={f.userId}
                  login={f.login}
                  avatarUrl={f.avatarUrl}
                  trailing={
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        onClick={() => handleAccept(f.userId)}
                        style={smallBtnStyle('#16a34a')}
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => handleDecline(f.userId)}
                        style={smallBtnStyle('#dc2626')}
                      >
                        Decline
                      </button>
                    </div>
                  }
                />
              ))}
            </div>
          )}
          {outgoing.length > 0 && (
            <div>
              <div style={sectionLabel}>Outgoing</div>
              {outgoing.map((f) => (
                <FriendRow
                  key={f.userId}
                  login={f.login}
                  avatarUrl={f.avatarUrl}
                  trailing={
                    <button
                      onClick={() => handleRemove(f.userId)}
                      style={smallBtnStyle('var(--muted)')}
                    >
                      Cancel
                    </button>
                  }
                />
              ))}
            </div>
          )}
          {incoming.length === 0 && outgoing.length === 0 && (
            <EmptyState title="No requests" message="No pending friend requests." />
          )}
        </div>
      )}

      {tab === 'search' && (
        <div>
          <SearchInput
            value={searchQuery}
            onChange={handleSearch}
            placeholder="Search by username..."
            style={{ marginBottom: '0.75rem' }}
          />
          {searchResults.map((u) => (
            <FriendRow
              key={u.userId}
              login={u.login}
              avatarUrl={u.avatarUrl}
              trailing={
                u.friendStatus === 'none' ? (
                  <button
                    onClick={() => handleRequest(u.userId)}
                    style={smallBtnStyle('var(--accent)')}
                  >
                    Add
                  </button>
                ) : u.friendStatus === 'pending_incoming' ? (
                  <button onClick={() => handleAccept(u.userId)} style={smallBtnStyle('#16a34a')}>
                    Accept
                  </button>
                ) : (
                  <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                    {u.friendStatus === 'accepted'
                      ? 'Friends'
                      : u.friendStatus === 'pending_outgoing'
                        ? 'Pending'
                        : 'Blocked'}
                  </span>
                )
              }
            />
          ))}
          {searchQuery.length >= 3 && searchResults.length === 0 && (
            <EmptyState title="No results" message={`No users found for "${searchQuery}".`} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function FriendRow({
  login,
  avatarUrl,
  trailing,
  onClick,
}: {
  login: string;
  avatarUrl: string | null;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        width: '100%',
        padding: '0.65rem 0.5rem',
        background: 'none',
        border: 'none',
        borderBottom: '1px solid var(--line)',
        textAlign: 'left',
        cursor: onClick ? 'pointer' : undefined,
        fontFamily: 'inherit',
        color: 'inherit',
      }}
    >
      <Avatar user={avatarUrl ? { id: '', login, avatarUrl, dateOfBirth: null } : null} size={28} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: '0.9rem',
          fontWeight: 600,
          color: 'var(--ink)',
        }}
      >
        {login}
      </div>
      {trailing && <div style={{ flexShrink: 0 }}>{trailing}</div>}
    </Tag>
  );
}

function smallBtnStyle(color: string): CSSProperties {
  return {
    padding: '0.25rem 0.6rem',
    borderRadius: 'var(--radius-sm, 0.5rem)',
    border: `1px solid ${color}`,
    background: 'transparent',
    color,
    fontSize: '0.75rem',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

const sectionLabel: CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 700,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  padding: '0.5rem 0',
};
