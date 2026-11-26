-- People judge generated audio, no AI does (#831). On each submission: the
-- contributor's own report from the device that generated it (good 1 / not good
-- 0, an optional note), and the app owner's review of that exact version
-- (#787): reviewed or needs_changes, a note, who and when. A version generated
-- again is a new submission, so it starts unreviewed. Owner reviews are also
-- audited in generation_audit ('artifact.review').
ALTER TABLE generation_submissions ADD COLUMN report_good INTEGER;
ALTER TABLE generation_submissions ADD COLUMN report_note TEXT;
ALTER TABLE generation_submissions ADD COLUMN reported_at INTEGER;
ALTER TABLE generation_submissions ADD COLUMN review TEXT CHECK (review IN ('reviewed', 'needs_changes'));
ALTER TABLE generation_submissions ADD COLUMN review_note TEXT;
ALTER TABLE generation_submissions ADD COLUMN reviewed_by TEXT;
ALTER TABLE generation_submissions ADD COLUMN reviewed_at INTEGER;
