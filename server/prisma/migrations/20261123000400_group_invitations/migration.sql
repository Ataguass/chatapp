BEGIN;

CREATE TABLE group_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    token_hash char(64) NOT NULL UNIQUE,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz(3) NOT NULL,
    max_uses integer NOT NULL DEFAULT 100,
    use_count integer NOT NULL DEFAULT 0,
    revoked_at timestamptz(3),
    CHECK (expires_at > created_at),
    CHECK (max_uses BETWEEN 1 AND 1000),
    CHECK (use_count BETWEEN 0 AND max_uses)
);
CREATE INDEX group_invitations_conversation_id_created_at_idx
    ON group_invitations (conversation_id, created_at);

COMMIT;
