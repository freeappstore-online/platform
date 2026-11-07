# Durable authorized data rooms

These HTTP endpoints require a session bearer token, including reads. They are
separate from `fas.collections` (owner-only unless shared) and ephemeral `fas.rooms` WebSocket
fan-out. Joining a WebSocket room never grants durable data access; messages sent
there are not protected by durable room membership. Do not broadcast secrets there.

Paths below are relative to `/v1/apps/:appId`:

| Method | Path | Permission / behavior |
| --- | --- | --- |
| POST | `/data-rooms` | Any authenticated user; server generates ID, creator owns room |
| PUT | `/data-rooms/:roomId/members/:userId` | Owner adds an explicit authenticated identity ID |
| DELETE | `/data-rooms/:roomId/members/:userId` | Owner removes member, or member leaves |
| DELETE | `/data-rooms/:roomId` | Owner permanently deletes room, memberships and documents |
| GET | `/data-rooms/:roomId/db/:collection` | Owner/member lists documents; limit (max 100), offset |
| POST | `/data-rooms/:roomId/db/:collection` | Owner/member creates JSON object; generated ID |
| GET | `/data-rooms/:roomId/db/:collection/:id` | Owner/member reads document |
| PUT | `/data-rooms/:roomId/db/:collection/:id` | Owner/member replaces entire document JSON object |
| DELETE | `/data-rooms/:roomId/db/:collection/:id` | Owner/member deletes document |

Use authenticated fetch with the existing session token. This API currently has no
SDK wrapper. Record responses are `{ id, data }`; list responses are
`{ documents: [{ id, data }] }`. Documents are limited to 64 KiB and collections to
10,000 records per room. Names contain letters, digits, colon, underscore or hyphen
and are at most 128 characters. Membership identity IDs use the same format.

The owner is the sole administrator and always has data access. Members have equal
read/write access to every collection in the room; there is no per-document secrecy
between members. Platform/app admin claims do not grant access. There is no public
join, invitation link, ownership transfer or additional admin role. Owner membership
cannot be removed; owners end their room by deleting it. Adding an existing member
returns 404 without changing membership. Removed members can be added again by the
owner. App deletion also purges its durable rooms. Deleting a local user account
purges its owned rooms and removes its memberships; ownership never transfers.

Authorization is evaluated inside each SQL data statement using the app, room and
current user identity. Nonmembers and missing resources return 404; missing/invalid
authentication returns 401. Caller-supplied owner/room filters confer no access.
Private data lives in separate tables, unreachable through public collection routes.
Responses carry `Cache-Control: no-store`.

A request whose SQL statement runs after removal/deletion is denied. A read whose
statement completed before removal may still return its earlier authorized snapshot;
revocation cannot retract bytes already read or delivered. Writes and membership
changes are ordered by database statement execution, not HTTP request start time.
