-- Platform-level date of birth. Set once by the user via any app, read by
-- all apps. Stored as TEXT in 'YYYY-MM-DD' form to avoid timezone drift.
-- Apps that need age compute it from this column; no per-app birthdays.

ALTER TABLE users ADD COLUMN date_of_birth TEXT;
