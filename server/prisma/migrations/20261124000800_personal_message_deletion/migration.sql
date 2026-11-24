CREATE TABLE message_deletions (
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  revision bigint NOT NULL,
  deleted_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (conversation_id, message_id) REFERENCES messages(conversation_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversation_members(conversation_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX message_deletions_sync_idx ON message_deletions(conversation_id, user_id, revision);
