-- Persist deploy step-by-step logs and agent errors to D1.
-- Previously only the final deploy_state was saved; errors lived only in the DO (lost after 24h).

ALTER TABLE agent_sessions ADD COLUMN deploy_log TEXT;  -- JSON array of timestamped deploy events
ALTER TABLE agent_sessions ADD COLUMN errors TEXT;      -- JSON array of {timestamp, source, message}
