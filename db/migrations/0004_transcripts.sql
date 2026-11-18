CREATE TABLE yuqu.transcript_jobs (
  id uuid PRIMARY KEY,
  media_version_id text NOT NULL UNIQUE REFERENCES yuqu.media_versions(id),
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  completed_ms integer NOT NULL DEFAULT 0 CHECK(completed_ms>=0),
  model text,
  model_info jsonb,
  lease_id uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcript_jobs_claim ON yuqu.transcript_jobs(available_at,created_at)
  WHERE status IN ('queued','processing');
CREATE INDEX transcript_jobs_user ON yuqu.transcript_jobs(user_id,created_at DESC);

CREATE TABLE yuqu.transcript_chunks (
  job_id uuid NOT NULL REFERENCES yuqu.transcript_jobs(id),
  chunk_index integer NOT NULL CHECK(chunk_index>=0),
  start_ms integer NOT NULL CHECK(start_ms>=0),
  end_ms integer NOT NULL CHECK(end_ms>start_ms),
  segments jsonb NOT NULL CHECK(jsonb_typeof(segments)='array'),
  language text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,chunk_index)
);

-- Existing private imports receive exactly one task; the synthetic tone fixture does not.
INSERT INTO yuqu.transcript_jobs(id,media_version_id,user_id)
SELECT gen_random_uuid(),id,owner_user_id FROM yuqu.media_versions
WHERE owner_user_id IS NOT NULL AND storage_key IS NOT NULL
ON CONFLICT(media_version_id) DO NOTHING;
