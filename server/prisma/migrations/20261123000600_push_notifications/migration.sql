BEGIN;

CREATE TYPE push_provider AS ENUM ('fcm');

CREATE TABLE push_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    device_id uuid NOT NULL,
    provider push_provider NOT NULL DEFAULT 'fcm',
    token varchar(4096) NOT NULL UNIQUE,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT push_tokens_device_user_fkey FOREIGN KEY (device_id, user_id)
        REFERENCES user_devices(id, user_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX push_tokens_user_id_idx ON push_tokens (user_id);
CREATE INDEX push_tokens_device_id_user_id_idx ON push_tokens (device_id, user_id);

COMMIT;
