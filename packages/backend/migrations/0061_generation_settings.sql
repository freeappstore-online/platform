-- Per-app community generation settings (#842). auto_block_below: the owner's
-- good-rate threshold (0-1) under which a contributor with enough judged
-- submissions is blocked automatically (generation_blocks, as a manual block);
-- null: off. A submission's judgement is the owner's review, else the
-- contributor's own device report (#831). Removed with the app by pruneGenerated.
CREATE TABLE generation_settings (
  app_id TEXT PRIMARY KEY,
  auto_block_below REAL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
