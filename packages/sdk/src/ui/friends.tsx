import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
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
    <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] p-[0_5px] rounded-full bg-danger text-white text-[0.7rem] font-bold ml-[6px]">
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
    none: { label: 'Add Friend', classes: 'text-white bg-accent', clickable: true },
    pending_outgoing: {
      label: 'Pending',
      classes: 'text-muted bg-panel',
      clickable: false,
    },
    pending_incoming: {
      label: 'Accept',
      classes: 'text-white bg-success',
      clickable: true,
    },
    accepted: {
      label: 'Friends',
      classes: 'text-muted bg-panel',
      clickable: false,
    },
    blocked_by_you: {
      label: 'Blocked',
      classes: 'text-danger bg-panel',
      clickable: false,
    },
  } as const;

  const cfg = status in config ? config[status as keyof typeof config] : config.none;

  return (
    <button
      onClick={cfg.clickable ? handleAction : undefined}
      disabled={busy || !cfg.clickable}
      className={[
        'p-[0.3rem_0.7rem]',
        'rounded-sm',
        'border border-line',
        'text-[0.8rem]',
        'font-semibold',
        cfg.clickable ? 'cursor-pointer' : 'cursor-default',
        'font-[inherit]',
        busy ? 'opacity-[0.6]' : 'opacity-[1]',
        cfg.classes,
      ]
        .filter(Boolean)
        .join(' ')}
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
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-4 w-full" />

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
                    className="rounded-sm border border-danger bg-transparent px-[0.6rem] py-1 text-xs font-semibold text-danger cursor-pointer"
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
            <div className="mb-4">
              <div className="text-[0.75rem] font-bold text-muted uppercase tracking-[0.05em] p-[0.5rem_0]">
                Incoming
              </div>
              {incoming.map((f) => (
                <FriendRow
                  key={f.userId}
                  login={f.login}
                  avatarUrl={f.avatarUrl}
                  trailing={
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAccept(f.userId)}
                        className="rounded-sm border border-success bg-transparent px-[0.6rem] py-1 text-xs font-semibold text-success cursor-pointer"
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => handleDecline(f.userId)}
                        className="rounded-sm border border-danger bg-transparent px-[0.6rem] py-1 text-xs font-semibold text-danger cursor-pointer"
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
              <div className="text-[0.75rem] font-bold text-muted uppercase tracking-[0.05em] p-[0.5rem_0]">
                Outgoing
              </div>
              {outgoing.map((f) => (
                <FriendRow
                  key={f.userId}
                  login={f.login}
                  avatarUrl={f.avatarUrl}
                  trailing={
                    <button
                      onClick={() => handleRemove(f.userId)}
                      className="rounded-sm border border-muted bg-transparent px-[0.6rem] py-1 text-xs font-semibold text-muted cursor-pointer"
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
            className="mb-3"
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
                    className="rounded-sm border border-accent bg-transparent px-[0.6rem] py-1 text-xs font-semibold text-accent cursor-pointer"
                  >
                    Add
                  </button>
                ) : u.friendStatus === 'pending_incoming' ? (
                  <button
                    onClick={() => handleAccept(u.userId)}
                    className="rounded-sm border border-success bg-transparent px-[0.6rem] py-1 text-xs font-semibold text-success cursor-pointer"
                  >
                    Accept
                  </button>
                ) : (
                  <span className="text-[0.75rem] text-muted">
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
      className={[
        'flex',
        'items-center',
        'gap-3',
        'w-full',
        'p-[0.65rem_0.5rem]',
        'bg-transparent',
        'border-0',
        'border-b border-line',
        'text-left',
        onClick ? 'cursor-pointer' : '',
        'font-[inherit]',
        'text-inherit',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Avatar user={avatarUrl ? { id: '', login, avatarUrl, dateOfBirth: null } : null} size={28} />
      <div className="flex-1 min-w-0 text-[0.9rem] font-semibold text-ink">{login}</div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </Tag>
  );
}
