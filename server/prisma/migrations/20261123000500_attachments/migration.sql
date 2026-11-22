BEGIN;

CREATE TYPE message_type AS ENUM ('text', 'image', 'video', 'audio', 'document');
CREATE TYPE media_category AS ENUM ('image', 'video', 'audio', 'document');

ALTER TABLE messages
    ADD COLUMN type message_type NOT NULL DEFAULT 'text',
    ADD COLUMN attachment_id uuid;
CREATE UNIQUE INDEX messages_attachment_id_key ON messages (attachment_id);

CREATE TABLE attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
    uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    storage_key varchar(36) NOT NULL UNIQUE,
    file_name varchar(255) NOT NULL,
    content_type varchar(127) NOT NULL,
    category media_category NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    sha256 char(64) NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX attachments_conversation_id_created_at_idx ON attachments (conversation_id, created_at);
ALTER TABLE messages
    ADD CONSTRAINT messages_attachment_id_fkey FOREIGN KEY (attachment_id)
        REFERENCES attachments(id) ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
