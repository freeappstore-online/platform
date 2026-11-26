-- No AI compute verifies community generation (#831): drop what Whisper
-- verification stored. The word error rate and transcripts of each submission
-- (0054, 0055), each job's sampled window positions (0055) and the set's
-- maximum error rate (0054). Nothing reads them since #831.
ALTER TABLE generation_submissions DROP COLUMN wer;
ALTER TABLE generation_submissions DROP COLUMN transcript;
ALTER TABLE generation_submissions DROP COLUMN window_transcripts;
ALTER TABLE generation_jobs DROP COLUMN windows;
ALTER TABLE generation_sets DROP COLUMN max_wer;
