BEGIN;

CREATE TABLE message_push_jobs (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  push_token_id uuid NOT NULL REFERENCES push_tokens(id) ON DELETE CASCADE ON UPDATE CASCADE,
  recipient_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  available_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_id uuid,
  PRIMARY KEY (message_id, push_token_id)
);
CREATE INDEX message_push_jobs_available_idx ON message_push_jobs(available_at, message_id, push_token_id);
CREATE INDEX message_push_jobs_created_at_idx ON message_push_jobs(created_at);
CREATE INDEX message_push_jobs_push_token_id_idx ON message_push_jobs(push_token_id);

COMMIT;
