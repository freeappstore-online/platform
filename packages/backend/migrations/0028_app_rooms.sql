-- Live realtime rooms per app, for the 64-rooms-per-app cap (#278).
-- A room is live while it has had a ticket or connect within the last 24h,
-- the same window the Room Durable Object uses to evict idle state.
CREATE TABLE IF NOT EXISTS app_rooms (
  app_id      TEXT NOT NULL,
  room_id     TEXT NOT NULL,
  last_active INTEGER NOT NULL,
  PRIMARY KEY (app_id, room_id)
);
CREATE INDEX IF NOT EXISTS idx_app_rooms_active ON app_rooms (app_id, last_active);
