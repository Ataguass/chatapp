BEGIN;

ALTER TABLE users ADD COLUMN deleted_at timestamptz(3);

CREATE TABLE account_recovery_codes (
  code_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX account_recovery_codes_user_id_idx ON account_recovery_codes(user_id);

CREATE TABLE pending_media_deletions (
  storage_key varchar(36) PRIMARY KEY,
  next_attempt_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX pending_media_deletions_next_attempt_at_idx ON pending_media_deletions(next_attempt_at);

CREATE FUNCTION require_active_account_for_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users
  WHERE id = (to_jsonb(NEW) ->> TG_ARGV[0])::uuid AND deleted_at IS NULL
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE foreign_key_violation USING MESSAGE = 'An active account is required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_require_active_account BEFORE INSERT ON conversation_members
FOR EACH ROW EXECUTE FUNCTION require_active_account_for_insert('user_id');

CREATE TRIGGER uploads_require_active_account BEFORE INSERT ON attachments
FOR EACH ROW EXECUTE FUNCTION require_active_account_for_insert('uploaded_by');

COMMIT;
