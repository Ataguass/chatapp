BEGIN;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username varchar(32) NOT NULL,
    display_name varchar(100) NOT NULL,
    password_hash text NOT NULL,
    avatar_url text,
    bio varchar(500),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_username_format CHECK (username COLLATE "C" ~ '^[a-z0-9_]{3,32}$'),
    CONSTRAINT users_display_name_present CHECK (length(trim(display_name)) > 0)
);
CREATE UNIQUE INDEX users_username_key ON users (username);

CREATE TABLE user_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    platform varchar(16) NOT NULL CHECK (platform IN ('android','ios','web','desktop')),
    device_name varchar(120) NOT NULL,
    last_seen_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX user_devices_id_user_id_key ON user_devices (id, user_id);
CREATE INDEX user_devices_user_id_idx ON user_devices (user_id);

CREATE TABLE user_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    device_id uuid NOT NULL,
    refresh_token_hash char(64) NOT NULL CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz(3) NOT NULL,
    revoked_at timestamptz(3),
    CHECK (expires_at > created_at),
    CONSTRAINT user_sessions_device_id_user_id_fkey FOREIGN KEY (device_id, user_id)
        REFERENCES user_devices(id, user_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX user_sessions_refresh_token_hash_key ON user_sessions (refresh_token_hash);
CREATE INDEX user_sessions_user_id_expires_at_idx ON user_sessions (user_id, expires_at);
CREATE INDEX user_sessions_device_id_user_id_idx ON user_sessions (device_id, user_id);

CREATE TABLE user_blocks (
    blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);
CREATE INDEX user_blocks_blocked_id_idx ON user_blocks (blocked_id);

COMMIT;
