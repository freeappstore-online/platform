CREATE TABLE IF NOT EXISTS documents (
  app_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, collection, id)
);

CREATE INDEX IF NOT EXISTS idx_docs_collection ON documents(app_id, collection, created_at);
CREATE INDEX IF NOT EXISTS idx_docs_owner ON documents(app_id, collection, owner_id);
