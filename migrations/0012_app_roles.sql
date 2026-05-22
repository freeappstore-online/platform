-- App-level RBAC. Stores per-app role assignments.
-- Default roles (owner, member, moderator, editor, viewer) are conventions
-- enforced by the SDK — the table stores any string as role_name so devs
-- can add custom roles without a migration.

CREATE TABLE IF NOT EXISTS app_roles (
  app_id    TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role_name TEXT NOT NULL,
  granted_by TEXT,          -- user_id of who assigned this role (audit trail)
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (app_id, user_id, role_name)
);

CREATE INDEX IF NOT EXISTS idx_app_roles_app ON app_roles (app_id);
CREATE INDEX IF NOT EXISTS idx_app_roles_user ON app_roles (user_id);
