-- Opt-in private rooms (#468).
--
-- Rooms stay open to any signed-in user by default. A room whose row here has
-- private = 1 hands out tickets only to users who hold an app role for the app
-- (routes/rooms.ts): its owner, or anyone the owner granted a role.
ALTER TABLE app_rooms ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
