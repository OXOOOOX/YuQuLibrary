ALTER TABLE yuqu.media_versions ADD COLUMN audio_available boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX media_storage_key_unique ON yuqu.media_versions(storage_key) WHERE storage_key IS NOT NULL;

-- Unlink is deliberately outside the user request. Rows survive crashes and keep
-- their bytes charged until the worker confirms that the files are gone.
CREATE TABLE yuqu.media_cleanup_jobs (
  storage_key text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  byte_size bigint NOT NULL CHECK(byte_size>=0),
  include_partial boolean NOT NULL DEFAULT false,
  available_at timestamptz NOT NULL DEFAULT now() + interval '30 seconds',
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_cleanup_available ON yuqu.media_cleanup_jobs(available_at,created_at);
CREATE INDEX media_cleanup_user ON yuqu.media_cleanup_jobs(user_id);
