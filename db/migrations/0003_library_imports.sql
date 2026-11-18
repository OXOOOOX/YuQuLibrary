ALTER TABLE yuqu.media_versions ADD COLUMN owner_user_id uuid REFERENCES yuqu.users(id);
ALTER TABLE yuqu.media_versions ADD COLUMN storage_key text;
ALTER TABLE yuqu.media_versions ADD COLUMN mime_type text;
ALTER TABLE yuqu.media_versions ADD COLUMN byte_size bigint;
ALTER TABLE yuqu.media_versions ADD COLUMN sha256 text;
ALTER TABLE yuqu.media_versions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX media_versions_owner_created ON yuqu.media_versions(owner_user_id,created_at DESC);

CREATE TABLE yuqu.import_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  source_url text NOT NULL,
  source_hash text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','downloading','ready','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_id uuid,
  lease_until timestamptz,
  media_version_id text REFERENCES yuqu.media_versions(id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,source_hash)
);
CREATE INDEX import_jobs_user_created ON yuqu.import_jobs(user_id,created_at DESC);
CREATE INDEX import_jobs_claim ON yuqu.import_jobs(status,lease_until,created_at) WHERE status IN ('queued','downloading');

ALTER TABLE yuqu.playback_takeovers ADD COLUMN target_media_version_id text;
ALTER TABLE yuqu.users ADD COLUMN last_feed_preview_at timestamptz;
CREATE TABLE yuqu.playback_history (
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  media_version_id text NOT NULL REFERENCES yuqu.media_versions(id),
  position_ms integer NOT NULL CHECK(position_ms>=0),
  speed double precision NOT NULL,
  looping boolean NOT NULL,
  PRIMARY KEY(user_id,media_version_id)
);
