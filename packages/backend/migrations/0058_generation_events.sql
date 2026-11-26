-- Generation attempt records (#813, #827): what a contributor device measured
-- while it ran one leased job, and how the attempt ended locally (the #813
-- reason vocabulary). Numbers and context only: no text, no audio, no tokens;
-- the device keeps the full record. One row per lease (a user is leased a job
-- once), so a resend replaces it. `generation_leases.submission_id` links it to
-- the upload. Pruned after 14 days by pruneGenerated.
CREATE TABLE generation_events (
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  runner TEXT NOT NULL,
  reason TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, user_id)
);
CREATE INDEX generation_events_created ON generation_events(created_at);
