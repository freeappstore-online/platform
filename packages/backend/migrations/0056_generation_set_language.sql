-- A set's language (#810): a BCP 47 tag such as en, zh or zh-Hans, passed to
-- Whisper and used for the default characters-per-second band. NULL keeps the
-- earlier behaviour (Whisper detects the language).
ALTER TABLE generation_sets ADD COLUMN language TEXT;
