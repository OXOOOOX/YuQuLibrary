CREATE TABLE yuqu.chapter_documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  media_version_id text NOT NULL REFERENCES yuqu.media_versions(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL REFERENCES yuqu.transcript_jobs(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  through_ms integer NOT NULL CHECK(through_ms>0 AND through_ms<=14400000),
  strategy text NOT NULL DEFAULT 'semantic-chapters-v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  UNIQUE(user_id,transcript_id,through_ms,strategy)
);
CREATE INDEX chapter_documents_media ON yuqu.chapter_documents(user_id,media_version_id,created_at DESC);
CREATE TABLE yuqu.chapter_batches (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES yuqu.chapter_documents(id) ON DELETE CASCADE,
  batch_index integer NOT NULL CHECK(batch_index>=0 AND batch_index<128),
  source_segments jsonb NOT NULL,
  result jsonb,
  result_input jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  agent_id text,
  lease_id uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,batch_index)
);
CREATE INDEX chapter_batches_claim ON yuqu.chapter_batches(document_id,batch_index) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX chapter_one_running ON yuqu.chapter_batches(document_id) WHERE status='running';
ALTER TABLE yuqu.bridge_presence ADD COLUMN task_types jsonb NOT NULL DEFAULT '["yuqu.chat.answer.v1"]';
