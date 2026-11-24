BEGIN;

CREATE TYPE report_category AS ENUM ('spam', 'harassment', 'inappropriate', 'other');
CREATE TYPE report_status AS ENUM ('pending', 'resolved', 'dismissed');

CREATE TABLE moderation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  category report_category NOT NULL,
  details varchar(1000) NOT NULL,
  status report_status NOT NULL DEFAULT 'pending',
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at timestamptz(3),
  reviewed_by_id uuid REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CHECK ((status = 'pending') = (reviewed_at IS NULL))
);
CREATE UNIQUE INDEX moderation_reports_message_id_reporter_id_key ON moderation_reports(message_id, reporter_id);
CREATE INDEX moderation_reports_reporter_id_idx ON moderation_reports(reporter_id);
CREATE INDEX moderation_reports_status_created_at_id_idx ON moderation_reports(status, created_at, id);

CREATE TABLE media_policies (
  category media_category PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  max_bytes integer NOT NULL CHECK (max_bytes > 0),
  content_types text[] NOT NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
);

COMMIT;
