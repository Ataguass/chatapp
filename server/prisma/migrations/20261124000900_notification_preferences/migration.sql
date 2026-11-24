BEGIN;
ALTER TABLE users ADD COLUMN push_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE conversation_members ADD COLUMN push_muted boolean NOT NULL DEFAULT false;
COMMIT;
