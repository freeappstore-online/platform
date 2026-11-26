-- Replica agreement for long audio (#784). A job's sampled window positions
-- (JSON fractions of the audio), drawn once so every replica is checked at the
-- same points, and each submission's per-window transcripts (JSON strings).
ALTER TABLE generation_jobs ADD COLUMN windows TEXT;
ALTER TABLE generation_submissions ADD COLUMN window_transcripts TEXT;
