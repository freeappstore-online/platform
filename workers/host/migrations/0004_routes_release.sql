-- Atomic keyless deploys (freeappstore-online/platform#460). The backend's
-- POST /v1/deploys/:id/commit sets `release` once every file of a deploy is in
-- R2; the host then serves `<r2_prefix>/.r/<release>/`. NULL keeps serving
-- `<r2_prefix>/` directly, which is where the legacy aws-sync workflows write.
ALTER TABLE routes ADD COLUMN release TEXT;
