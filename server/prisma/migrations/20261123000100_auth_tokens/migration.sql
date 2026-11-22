BEGIN;

ALTER TABLE user_sessions
    ADD COLUMN access_token_hash char(64),
    ADD COLUMN access_expires_at timestamptz(3);

-- Existing refresh-only sessions cannot authenticate with the new access-token
-- format. Mark them revoked and give each row an unusable unique digest.
UPDATE user_sessions
SET access_token_hash = md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text),
    access_expires_at = created_at,
    revoked_at = COALESCE(revoked_at, created_at);

ALTER TABLE user_sessions
    ALTER COLUMN access_token_hash SET NOT NULL,
    ALTER COLUMN access_expires_at SET NOT NULL,
    ADD CONSTRAINT user_sessions_access_expiration_check
        CHECK (access_expires_at <= expires_at);

CREATE UNIQUE INDEX user_sessions_access_token_hash_key
    ON user_sessions (access_token_hash);

COMMIT;
