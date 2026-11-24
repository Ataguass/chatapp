BEGIN;

CREATE TYPE story_kind AS ENUM ('text', 'image', 'video');
CREATE TYPE story_visibility AS ENUM ('everyone', 'connections', 'selected', 'excluded');

CREATE TABLE stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  client_id uuid NOT NULL,
  kind story_kind NOT NULL,
  text text NOT NULL,
  storage_key varchar(36),
  file_name varchar(255),
  content_type varchar(127),
  size_bytes bigint,
  sha256 char(64),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz(3) NOT NULL,
  CONSTRAINT stories_media_check CHECK (
    (kind = 'text' AND num_nonnulls(storage_key, file_name, content_type, size_bytes, sha256) = 0)
    OR (kind <> 'text' AND num_nonnulls(storage_key, file_name, content_type, size_bytes, sha256) = 5 AND size_bytes > 0)
  )
);
CREATE UNIQUE INDEX stories_user_id_client_id_key ON stories(user_id, client_id);
CREATE UNIQUE INDEX stories_storage_key_key ON stories(storage_key);
CREATE INDEX stories_expires_at_idx ON stories(expires_at);
CREATE INDEX stories_created_at_id_idx ON stories(created_at, id);

CREATE TABLE story_views (
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE ON UPDATE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  viewed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (story_id, viewer_id)
);
CREATE INDEX story_views_viewer_id_idx ON story_views(viewer_id);

CREATE TABLE story_privacy (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  visibility story_visibility NOT NULL DEFAULT 'connections'
);

CREATE TABLE story_audience (
  owner_id uuid NOT NULL REFERENCES story_privacy(user_id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (owner_id, user_id),
  CONSTRAINT story_audience_no_self CHECK (owner_id <> user_id)
);
CREATE INDEX story_audience_user_id_idx ON story_audience(user_id);

COMMIT;
