ALTER TABLE yuqu.import_jobs ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX import_jobs_available ON yuqu.import_jobs(available_at,created_at) WHERE status='queued';
