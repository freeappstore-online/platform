-- Community generation (#727, #728): routes/generation.ts.
--
-- The app owner publishes sets (model + params) and jobs (key + input). Devices
-- claim a job under a lease and upload against it into quarantine. The verifier
-- promotes a passing submission into generation_artifacts, whose job_id
-- PRIMARY KEY is the write-once authority: a second accept for a job can never
-- insert, so nothing is overwritten. Only the owner's withdrawal (audited)
-- deletes an artifact and reopens its job.
CREATE TABLE generation_sets (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tts')),
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  params TEXT NOT NULL,
  formats TEXT NOT NULL,
  max_bytes INTEGER NOT NULL,
  replicas INTEGER NOT NULL CHECK (replicas BETWEEN 1 AND 3),
  require_attestation INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX generation_sets_app ON generation_sets(app_id);

-- id = sha256 of set + key + input + model/version/params. status 'accepted'
-- while an artifact exists for the job.
CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES generation_sets(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  key TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted')),
  created_at INTEGER NOT NULL,
  UNIQUE (set_id, key)
);
CREATE INDEX generation_jobs_claim ON generation_jobs(app_id, status, created_at);

-- PRIMARY KEY (job_id, user_id): a user is never given the same job twice.
CREATE TABLE generation_leases (
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'used', 'released')),
  submission_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, user_id)
);
CREATE INDEX generation_leases_user ON generation_leases(user_id, state);

CREATE TABLE generation_submissions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  set_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_kind TEXT NOT NULL CHECK (device_kind IN ('web', 'native')),
  attestation TEXT NOT NULL CHECK (attestation IN ('none', 'unverified', 'verified')),
  object_key TEXT NOT NULL,
  meta_key TEXT,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX generation_submissions_user ON generation_submissions(user_id, created_at);
CREATE INDEX generation_submissions_job ON generation_submissions(job_id, status);
CREATE INDEX generation_submissions_pending ON generation_submissions(status, created_at);

-- user_id is cleared when the contributor deletes their account.
CREATE TABLE generation_artifacts (
  job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id) ON DELETE CASCADE,
  set_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  key TEXT NOT NULL,
  submission_id TEXT NOT NULL UNIQUE,
  user_id TEXT,
  device_kind TEXT NOT NULL,
  attestation TEXT NOT NULL,
  object_key TEXT NOT NULL,
  meta_key TEXT,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  duration_ms INTEGER,
  sha256 TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);
CREATE INDEX generation_artifacts_set ON generation_artifacts(set_id, key);
CREATE INDEX generation_artifacts_user ON generation_artifacts(app_id, user_id);

CREATE TABLE generation_blocks (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  blocked_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE generation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX generation_audit_app ON generation_audit(app_id, created_at);
