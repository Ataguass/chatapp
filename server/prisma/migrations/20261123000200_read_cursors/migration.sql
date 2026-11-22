BEGIN;

CREATE TABLE conversation_read_cursors (
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_read_message_id uuid NOT NULL,
    last_read_message_created_at timestamptz(3) NOT NULL,
    read_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id),
    CONSTRAINT conversation_read_cursors_conversation_id_user_id_fkey
        FOREIGN KEY (conversation_id, user_id)
        REFERENCES conversation_members(conversation_id, user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX conversation_read_cursors_user_id_read_at_idx
    ON conversation_read_cursors (user_id, read_at);

COMMIT;
