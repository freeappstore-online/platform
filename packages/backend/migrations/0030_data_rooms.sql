-- Durable authorized data is deliberately separate from public documents and WS rooms.
CREATE TABLE data_rooms (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
);
CREATE TABLE data_room_members (
  app_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (app_id, room_id, user_id)
);
CREATE TABLE data_room_documents (
  app_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (app_id, room_id, collection, id)
);
CREATE TRIGGER data_room_delete AFTER DELETE ON data_rooms BEGIN
  DELETE FROM data_room_members WHERE app_id = OLD.app_id AND room_id = OLD.id;
  DELETE FROM data_room_documents WHERE app_id = OLD.app_id AND room_id = OLD.id;
END;
CREATE TRIGGER data_room_app_delete AFTER DELETE ON apps BEGIN
  DELETE FROM data_rooms WHERE app_id = OLD.id;
END;
CREATE TRIGGER data_room_user_delete AFTER DELETE ON users BEGIN
  DELETE FROM data_rooms WHERE owner_id = OLD.id;
  DELETE FROM data_room_members WHERE user_id = OLD.id;
END;
