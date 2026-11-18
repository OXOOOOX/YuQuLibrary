CREATE TABLE yuqu.summary_documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  media_version_id text NOT NULL REFERENCES yuqu.media_versions(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL REFERENCES yuqu.transcript_jobs(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  title text NOT NULL,
  through_ms integer NOT NULL CHECK(through_ms>0 AND through_ms<=14400000),
  strategy text NOT NULL DEFAULT 'hierarchical-summary-v1',
  total_parts integer NOT NULL CHECK(total_parts BETWEEN 1 AND 128),
  root_index integer NOT NULL CHECK(root_index BETWEEN 0 AND 146),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  UNIQUE(user_id,transcript_id,through_ms,strategy)
);
CREATE INDEX summary_documents_media ON yuqu.summary_documents(user_id,media_version_id,created_at DESC);
CREATE TABLE yuqu.summary_nodes (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES yuqu.summary_documents(id) ON DELETE CASCADE,
  node_index integer NOT NULL CHECK(node_index BETWEEN 0 AND 146),
  level integer NOT NULL CHECK(level BETWEEN 0 AND 3),
  group_index integer NOT NULL CHECK(group_index BETWEEN 0 AND 127),
  group_count integer NOT NULL CHECK(group_count BETWEEN 1 AND 128 AND group_index<group_count),
  child_indexes integer[] NOT NULL,
  source_segments jsonb,
  start_ms integer NOT NULL CHECK(start_ms>=0),
  end_ms integer NOT NULL CHECK(end_ms>=start_ms AND end_ms<=14400000),
  input jsonb,
  result jsonb,
  result_input jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  agent_id text,
  lease_id uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((level=0 AND cardinality(child_indexes)=0 AND source_segments IS NOT NULL) OR
    (level>0 AND cardinality(child_indexes) BETWEEN 1 AND 8 AND source_segments IS NULL)),
  UNIQUE(document_id,node_index)
);
CREATE INDEX summary_nodes_claim ON yuqu.summary_nodes(document_id,node_index) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX summary_one_running ON yuqu.summary_nodes(document_id) WHERE status='running';
