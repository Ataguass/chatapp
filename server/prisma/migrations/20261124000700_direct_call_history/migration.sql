BEGIN;

CREATE TYPE direct_call_kind AS ENUM ('voice', 'video');
CREATE TYPE direct_call_end_reason AS ENUM ('ended', 'declined', 'no_answer', 'disconnected', 'offline', 'interrupted', 'unavailable');

CREATE TABLE direct_calls (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  caller_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind direct_call_kind NOT NULL,
  started_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at timestamptz(3),
  ended_at timestamptz(3),
  end_reason direct_call_end_reason,
  CHECK (caller_id <> recipient_id),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX direct_calls_caller_id_started_at_id_idx ON direct_calls(caller_id, started_at, id);
CREATE INDEX direct_calls_recipient_id_started_at_id_idx ON direct_calls(recipient_id, started_at, id);
CREATE INDEX direct_calls_conversation_id_idx ON direct_calls(conversation_id);

COMMIT;
