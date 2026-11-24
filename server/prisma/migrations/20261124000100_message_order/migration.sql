BEGIN;

ALTER TABLE conversations ADD COLUMN last_message_position bigint NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN position bigint NOT NULL DEFAULT 0;
ALTER TABLE conversation_read_cursors ADD COLUMN last_read_message_position bigint NOT NULL DEFAULT 0;

WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS position
  FROM messages
)
UPDATE messages AS message SET position = ordered.position FROM ordered WHERE message.id = ordered.id;

UPDATE conversations AS conversation SET last_message_position = totals.position
FROM (SELECT conversation_id, max(position) AS position FROM messages GROUP BY conversation_id) AS totals
WHERE conversation.id = totals.conversation_id;

UPDATE conversation_read_cursors AS cursor SET last_read_message_position = message.position
FROM messages AS message
WHERE cursor.conversation_id = message.conversation_id AND cursor.last_read_message_id = message.id;

CREATE UNIQUE INDEX messages_conversation_id_position_key ON messages(conversation_id, position);

CREATE FUNCTION assign_message_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- This row stays locked until the insert commits, so later sends cannot skip a position.
  UPDATE conversations
  SET last_message_position = last_message_position + 1
  WHERE id = NEW.conversation_id
  RETURNING last_message_position INTO NEW.position;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_assign_position BEFORE INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION assign_message_position();

COMMIT;
