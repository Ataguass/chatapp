CREATE TABLE conversation_delivery_cursors (
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  message_id uuid NOT NULL,
  position bigint NOT NULL,
  delivered_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT conversation_delivery_cursors_conversation_id_user_id_fkey
    FOREIGN KEY (conversation_id, user_id) REFERENCES conversation_members(conversation_id, user_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
