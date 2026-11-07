-- Private-by-default documents (#467).
--
-- A collection is readable by users other than the document owner only when
-- it has a row here with shared = 1. With no row, every read is owner-only and
-- `_owner` is never shown to anyone else. The app owner marks a collection
-- shared with `fas db share <collection>` (PUT /v1/apps/:appId/collections/:name).
CREATE TABLE IF NOT EXISTS collection_settings (
  app_id     TEXT NOT NULL,
  collection TEXT NOT NULL,
  shared     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, collection)
);

-- Seed: every collection an existing app deliberately shares between users,
-- found by grepping the freeappstore-online app repos for collections usage
-- (2026-11-08):
--   artout/posts, faces/faces        public feeds of user posts
--   music-share/shared-playlists     playlists shared by link
--   card/cards                       published business cards, opened by link (/c/<id>)
--   planning-poker/*                 sessions, tickets, rounds and votes shared by the room
--   study-room/study-room-rooms      registry of rooms to join
--   streak/{grids,profiles}          buddies read each other's public grids and profiles
--   whenly/{polls,votes}             poll votes are read by everyone with the link
--   calendar/booking_pages           the public booking page a guest opens
-- calendar's calendar_invites and bookings are deliberately NOT here: they hold
-- private event and booking data and become owner-only.
INSERT OR IGNORE INTO collection_settings (app_id, collection, shared, updated_at)
VALUES
  ('artout', 'posts', 1, unixepoch() * 1000),
  ('faces', 'faces', 1, unixepoch() * 1000),
  ('music-share', 'shared-playlists', 1, unixepoch() * 1000),
  ('card', 'cards', 1, unixepoch() * 1000),
  ('planning-poker', 'tickets', 1, unixepoch() * 1000),
  ('planning-poker', 'sessions', 1, unixepoch() * 1000),
  ('planning-poker', 'sprints', 1, unixepoch() * 1000),
  ('planning-poker', 'rounds', 1, unixepoch() * 1000),
  ('planning-poker', 'votes', 1, unixepoch() * 1000),
  ('planning-poker', 'final-estimates', 1, unixepoch() * 1000),
  ('study-room', 'study-room-rooms', 1, unixepoch() * 1000),
  ('streak', 'grids', 1, unixepoch() * 1000),
  ('streak', 'profiles', 1, unixepoch() * 1000),
  ('whenly', 'polls', 1, unixepoch() * 1000),
  ('whenly', 'votes', 1, unixepoch() * 1000),
  ('calendar', 'booking_pages', 1, unixepoch() * 1000);
