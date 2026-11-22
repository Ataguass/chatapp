BEGIN;

ALTER TABLE messages
    ADD COLUMN reply_to_message_id uuid;
CREATE UNIQUE INDEX messages_conversation_id_id_key ON messages (conversation_id, id);
ALTER TABLE messages
    ADD CONSTRAINT messages_reply_to_message_id_fkey
        FOREIGN KEY (reply_to_message_id) REFERENCES messages(id)
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE message_reactions (
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji varchar(16) NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id, emoji),
    CONSTRAINT message_reactions_conversation_id_message_id_fkey
        FOREIGN KEY (conversation_id, message_id)
        REFERENCES messages(conversation_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT message_reactions_conversation_id_user_id_fkey
        FOREIGN KEY (conversation_id, user_id)
        REFERENCES conversation_members(conversation_id, user_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT message_reactions_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX message_reactions_conversation_id_message_id_emoji_idx
    ON message_reactions (conversation_id, message_id, emoji);

COMMIT;
