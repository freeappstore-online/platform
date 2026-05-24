-- Platform-level friendships
CREATE TABLE IF NOT EXISTS friendships (
  user_a     TEXT NOT NULL,
  user_b     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  initiator  TEXT NOT NULL,
  blocker    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b),
  CHECK (status IN ('pending', 'accepted', 'blocked'))
);

CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships (user_a, status);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships (user_b, status);
CREATE INDEX IF NOT EXISTS idx_users_login ON users (github_login);
