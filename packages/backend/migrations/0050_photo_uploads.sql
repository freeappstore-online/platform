-- Pending rows reserve quota atomically before R2 writes. Tombstones preserve
-- daily upload accounting even when an uploader deletes a photo immediately.
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleted')),
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX photos_app_created ON photos(app_id, created_at);
CREATE INDEX photos_owner_created ON photos(owner_id, created_at);
CREATE INDEX photos_expiry ON photos(expires_at);
