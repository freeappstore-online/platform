-- Reminder schedules for `fas.push` (#146). An app registers a reminder for a
-- user; the */15 cron sends a no-payload Web Push to that user's devices for
-- the app (push_subscriptions, 0025) when next_at comes due.
--
-- rule is JSON (lib/push-schedule.ts): a one-shot {type:'at'} or a simple
-- repeat ({type:'daily'} / {type:'every', days}) at an HH:MM wall-clock time
-- in tz, an IANA zone, so repeats keep their local time across DST.
-- quiet_start/quiet_end are minutes after local midnight (the window may wrap
-- midnight); a reminder due inside it is held until the window ends.
-- next_at is when to try next; occurrence_at is the occurrence that try
-- belongs to. They differ while a reminder is held for quiet hours or retried,
-- and repeats advance from occurrence_at so a delay never skips a day.
-- attempts counts consecutive deliveries that reached no device because of
-- transient push-service errors; the cron retries a few times, then moves on.

CREATE TABLE IF NOT EXISTS push_schedules (
  id          TEXT    PRIMARY KEY,
  app_id      TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  reminder_id TEXT    NOT NULL,
  next_at       INTEGER NOT NULL,
  occurrence_at INTEGER NOT NULL,
  rule        TEXT    NOT NULL,
  tz          TEXT    NOT NULL,
  quiet_start INTEGER,
  quiet_end   INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (app_id, user_id, reminder_id)
);

CREATE INDEX IF NOT EXISTS idx_push_schedules_next_at ON push_schedules (next_at);
CREATE INDEX IF NOT EXISTS idx_push_schedules_user    ON push_schedules (user_id);
