# Platform Friends System

## Problem

Apps like Calendar need to let users invite each other to events. Without a friends system, any user can spam any other user with invitations. This is the same problem Discord solved: you discover people through servers (apps), but direct interactions (DMs, invites) require a mutual friendship.

Friends is a platform-level feature, not per-app. Once two users are friends, every app on FreeAppStore can use that relationship for invitations, sharing, multiplayer matchmaking, etc.

## Design Principles

- **Mutual consent.** Both sides must accept. No one-way follows.
- **Platform-level.** Friends persist across all apps. Unfriending in one app unfriends everywhere.
- **Discoverable through apps.** Users meet through apps (rooms, leaderboards, bookings) and then add each other as friends.
- **Blocking is absolute.** A blocked user cannot send friend requests, see your presence, or interact with you in any app. Apps can query block status to enforce this.
- **Lightweight.** No friend categories, no tiers, no close-friends. Just friends or not.

## Data Model

### D1 Table: `friendships`

```sql
CREATE TABLE friendships (
  user_a    TEXT NOT NULL,           -- lower user ID (alphabetically)
  user_b    TEXT NOT NULL,           -- higher user ID (alphabetically)
  status    TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | blocked
  initiator TEXT NOT NULL,           -- who sent the request (user_a or user_b)
  blocker   TEXT,                    -- who blocked (only set when status = blocked)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);

CREATE INDEX idx_friendships_user_a ON friendships(user_a, status);
CREATE INDEX idx_friendships_user_b ON friendships(user_b, status);
```

**Why alphabetical ordering?** Each friendship is stored as exactly one row. `user_a` is always the lexicographically smaller ID. This prevents duplicate rows (A,B) and (B,A) without needing a unique constraint on unordered pairs.

### D1 Table: `friend_lookup`

Maps login (username) to user ID for the friend request flow, since users type usernames not IDs.

```sql
-- Already exists: the `users` table has `id` and `github_login`.
-- No new table needed. Use: SELECT id, avatar_url FROM users WHERE github_login = ?
```

## API Routes

All routes require authentication (`Bearer` token).

### Send friend request

```
POST /v1/friends/request
Body: { "login": "janedoe" }

Response 201: { "status": "pending", "user": { "id": "...", "login": "janedoe", "avatarUrl": "..." } }
Response 200: { "status": "accepted" }  -- if they already sent you a request, auto-accept
Response 400: "cannot friend yourself"
Response 404: "user not found"
Response 409: "already friends" | "already pending" | "blocked"
```

**Auto-accept logic:** If Jane already has a pending request to you, your request to Jane immediately accepts the friendship (mutual consent satisfied). No second confirmation needed.

### List friends

```
GET /v1/friends
Query: ?status=accepted (default) | pending_incoming | pending_outgoing | all

Response 200: {
  "friends": [
    { "id": "github:123", "login": "janedoe", "avatarUrl": "...", "since": 1716600000000 }
  ]
}
```

### Respond to request

```
PATCH /v1/friends/:userId
Body: { "action": "accept" | "decline" | "block" }

Response 200: { "status": "accepted" | "declined" | "blocked" }
Response 404: "no pending request from this user"
```

`decline` deletes the row entirely (they can re-request later). `block` sets status to `blocked` and records the blocker.

### Remove friend / Unblock

```
DELETE /v1/friends/:userId

Response 200: { "removed": true }
Response 404: "no friendship found"
```

Deletes the row entirely. Works for unfriending (accepted) and unblocking (blocked).

### Check friendship

```
GET /v1/friends/check/:userId

Response 200: { "status": "accepted" | "pending" | "blocked" | "none" }
```

Fast check for apps to gate features. Returns `none` if no relationship exists.

### Search users (for adding friends)

```
GET /v1/friends/search?q=jane
Query: q (min 2 chars, searches github_login prefix)

Response 200: {
  "users": [
    { "id": "github:123", "login": "janedoe", "avatarUrl": "...", "friendStatus": "none" | "pending" | "accepted" }
  ]
}
```

Limited to 10 results. Excludes blocked users. Includes friendship status so the UI can show "Add" vs "Pending" vs "Friends".

## SDK Module: `fas.friends`

```typescript
interface Friend {
  id: string
  login: string
  avatarUrl: string | null
  since: number  // timestamp, only for accepted friends
}

interface UserSearchResult {
  id: string
  login: string
  avatarUrl: string | null
  friendStatus: 'none' | 'pending' | 'accepted'
}

class Friends {
  /** List accepted friends. */
  async list(): Promise<Friend[]>

  /** List incoming pending friend requests. */
  async requests(): Promise<Friend[]>

  /** Send a friend request by username. Auto-accepts if they already requested you. */
  async request(login: string): Promise<{ status: 'pending' | 'accepted' }>

  /** Accept or decline an incoming friend request. */
  async respond(userId: string, action: 'accept' | 'decline'): Promise<void>

  /** Remove a friend or unblock a user. */
  async remove(userId: string): Promise<void>

  /** Block a user. Removes any existing friendship. */
  async block(userId: string): Promise<void>

  /** Check if a specific user is your friend. */
  async isFriend(userId: string): Promise<boolean>

  /** Search users by username prefix. Returns up to 10 matches with friendship status. */
  async search(query: string): Promise<UserSearchResult[]>
}
```

## React Hook: `useFriends`

```typescript
import { useFriends } from '@freeappstore/sdk/hooks'

function MyComponent() {
  const {
    friends,           // Friend[] -- accepted friends
    requests,          // Friend[] -- pending incoming requests
    loading,           // boolean
    requestCount,      // number -- pending incoming count (for badges)
    sendRequest,       // (login: string) => Promise<void>
    respond,           // (userId: string, action) => Promise<void>
    remove,            // (userId: string) => Promise<void>
    search,            // (query: string) => Promise<UserSearchResult[]>
  } = useFriends(fas)
}
```

## UI Components

### `FriendsList`

Full-page or panel showing your friends list. Used by any app that needs a friend picker.

```tsx
import { FriendsList } from '@freeappstore/sdk/ui'

<FriendsList app={fas} onSelect={(friend) => inviteToEvent(friend)} />
```

Shows: avatar, username, "Remove" action. Search bar at top filters the list.

### `FriendRequestBadge`

Small badge showing pending request count. Apps put this in their toolbar.

```tsx
import { FriendRequestBadge } from '@freeappstore/sdk/ui'

<FriendRequestBadge app={fas} />  // renders nothing if count is 0
```

### `AddFriendButton`

Inline button for adding someone as a friend. Used in leaderboards, room member lists, etc.

```tsx
import { AddFriendButton } from '@freeappstore/sdk/ui'

<AddFriendButton app={fas} userId="github:123" login="janedoe" />
// Shows: "Add Friend" | "Pending" | "Friends" depending on status
```

## How Apps Use It

### Calendar (invitations)

The calendar event modal currently has a free-text username input for attendees. With the friends system:

1. Replace the text input with a friend picker (search your friends list)
2. Only friends can be invited -- no spam from strangers
3. The invitation is still stored in `calendar_invites` collection, but the calendar checks `fas.friends.isFriend(userId)` before creating it
4. If someone who isn't your friend visits your booking page, they can still book (booking is public by design) but event invitations are friends-only

### Games (multiplayer)

- Challenge a friend to a game
- Show "Add Friend" button on the post-game screen
- Friends list as a lobby for starting matches

### Rooms (any app with real-time)

- See which friends are online in a room
- Invite friends to join your room

### Messenger / Chat apps

- Only friends can DM each other
- Friend requests are the conversation starter

## What About the ProfileMenu?

The SDK's `ProfileMenu` component (the avatar dropdown in the top bar) should get a "Friends" item that opens a friends management panel. This gives every app a consistent way to manage friends without building custom UI.

```
[Avatar] janedoe
  - Theme: Light / Dark / System
  - Friends (3)        <-- new
  - Sign out
  - Delete account
```

## Migration Path

### Phase 1: Backend + SDK (ship first)

1. Add `friendships` table migration
2. Add API routes to the backend
3. Add `Friends` class to the SDK
4. Add `useFriends` hook
5. Publish SDK v0.13.0

### Phase 2: UI Components

1. Add `FriendsList`, `FriendRequestBadge`, `AddFriendButton` to SDK UI
2. Add "Friends" to `ProfileMenu`

### Phase 3: App Integration

1. Update Calendar to use friend picker for invitations
2. Update any game with multiplayer to show "Add Friend" on game-over
3. Add `AddFriendButton` to room member lists

## Privacy

- Friend lists are private. Only you can see your friends.
- Apps can check if two specific users are friends (`isFriend`), but cannot enumerate another user's friend list.
- Blocking is invisible to the blocked party. They see `none` status, not `blocked`.
- The search endpoint only returns users who have a public profile (signed in to at least one app). It does not expose the full user database.
- Friend count is not exposed publicly. No "123 friends" on profiles.

## Limits (Free Tier)

- Max 200 friends per user
- Max 50 pending outgoing requests
- Max 10 search results per query
- Rate limit: 20 friend operations per minute
