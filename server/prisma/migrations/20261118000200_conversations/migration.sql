BEGIN;

CREATE TYPE conversation_kind AS ENUM ('direct', 'group');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type conversation_kind NOT NULL,
    title varchar(120),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE direct_conversations (
    conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
    user_one_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    user_two_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CHECK (user_one_id < user_two_id)
);
CREATE UNIQUE INDEX direct_conversations_user_one_id_user_two_id_key ON direct_conversations (user_one_id, user_two_id);
CREATE INDEX direct_conversations_user_two_id_idx ON direct_conversations (user_two_id);

CREATE TABLE conversation_members (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    role member_role NOT NULL DEFAULT 'member',
    joined_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at timestamptz(3),
    PRIMARY KEY (conversation_id, user_id),
    CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE INDEX conversation_members_user_id_left_at_idx ON conversation_members (user_id, left_at);

CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    client_message_id uuid NOT NULL,
    content text NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at timestamptz(3),
    deleted_at timestamptz(3),
    CONSTRAINT messages_conversation_id_sender_id_fkey FOREIGN KEY (conversation_id, sender_id)
        REFERENCES conversation_members(conversation_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX messages_conversation_id_sender_id_client_message_id_key
    ON messages (conversation_id, sender_id, client_message_id);
CREATE INDEX messages_conversation_id_created_at_id_idx ON messages (conversation_id, created_at, id);

COMMIT;
