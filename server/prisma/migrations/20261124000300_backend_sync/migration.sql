BEGIN;

ALTER TABLE messages ADD COLUMN forwarded boolean NOT NULL DEFAULT false;

CREATE INDEX conversation_members_active_page_idx
  ON conversation_members(user_id, left_at, joined_at, conversation_id);

CREATE TABLE conversation_sync_state (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  revision bigint NOT NULL
);

-- Each changed message has one entry, including a tombstone if it was physically removed.
CREATE TABLE conversation_message_changes (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  message_id uuid NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

CREATE UNIQUE INDEX conversation_message_changes_revision_key
  ON conversation_message_changes(conversation_id, revision);

CREATE FUNCTION record_conversation_message_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  chat_id uuid := COALESCE(NEW.conversation_id, OLD.conversation_id);
  changed_id uuid;
  next_revision bigint;
BEGIN
  -- Cascading deletion of the conversation also removes its synchronization state.
  IF NOT EXISTS (SELECT 1 FROM conversations WHERE id = chat_id) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'messages' THEN
    changed_id := COALESCE(NEW.id, OLD.id);
  ELSE
    changed_id := COALESCE(NEW.message_id, OLD.message_id);
  END IF;

  -- The counter row stays locked through commit, so a cursor cannot skip an uncommitted revision.
  INSERT INTO conversation_sync_state (conversation_id, revision) VALUES (chat_id, 1)
  ON CONFLICT (conversation_id) DO UPDATE SET revision = conversation_sync_state.revision + 1
  RETURNING revision INTO next_revision;

  INSERT INTO conversation_message_changes (conversation_id, message_id, revision)
  VALUES (chat_id, changed_id, next_revision)
  ON CONFLICT (conversation_id, message_id) DO UPDATE SET revision = EXCLUDED.revision;
  RETURN NULL;
END;
$$;

CREATE TRIGGER messages_record_sync_change AFTER INSERT OR UPDATE OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION record_conversation_message_change();

CREATE TRIGGER reactions_record_sync_change AFTER INSERT OR DELETE ON message_reactions
FOR EACH ROW EXECUTE FUNCTION record_conversation_message_change();

COMMIT;
