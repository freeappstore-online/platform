-- Community generation verification (#729). Per-set thresholds, and each
-- submission's verdict: passed (1/0) once checked, the measured duration, word
-- error rate and, for audio transcribed whole, the transcript (replicas compare
-- it). verifying_at locks a submission while one verifier works on it.
ALTER TABLE generation_sets ADD COLUMN min_cps REAL NOT NULL DEFAULT 8;
ALTER TABLE generation_sets ADD COLUMN max_cps REAL NOT NULL DEFAULT 30;
ALTER TABLE generation_sets ADD COLUMN max_wer REAL NOT NULL DEFAULT 0.25;
ALTER TABLE generation_submissions ADD COLUMN passed INTEGER;
ALTER TABLE generation_submissions ADD COLUMN duration_ms INTEGER;
ALTER TABLE generation_submissions ADD COLUMN wer REAL;
ALTER TABLE generation_submissions ADD COLUMN transcript TEXT;
ALTER TABLE generation_submissions ADD COLUMN verifying_at INTEGER;
