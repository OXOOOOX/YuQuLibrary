CREATE TABLE yuqu.chat_conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  media_version_id text NOT NULL REFERENCES yuqu.media_versions(id),
  next_sequence integer NOT NULL DEFAULT 1,
  UNIQUE(user_id,media_version_id)
);
CREATE TABLE yuqu.chat_turns (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES yuqu.chat_conversations(id),
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  request_id uuid NOT NULL,
  sequence integer NOT NULL,
  media_version_id text NOT NULL REFERENCES yuqu.media_versions(id),
  transcript_id uuid NOT NULL REFERENCES yuqu.transcript_jobs(id),
  position_ms integer NOT NULL CHECK(position_ms>=0),
  scope text NOT NULL CHECK(scope IN ('near','until','all')),
  question text NOT NULL CHECK(length(question) BETWEEN 1 AND 2000),
  answer text NOT NULL DEFAULT '' CHECK(length(answer)<=24000),
  context jsonb NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  agent_id text,
  lease_id uuid,
  lease_until timestamptz,
  event_sequence integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  UNIQUE(conversation_id,sequence)
);
CREATE UNIQUE INDEX chat_one_pending ON yuqu.chat_turns(conversation_id) WHERE status IN ('queued','running');
CREATE INDEX chat_claim ON yuqu.chat_turns(created_at) WHERE status IN ('queued','running');
CREATE INDEX chat_user_created ON yuqu.chat_turns(user_id,created_at DESC);
CREATE TABLE yuqu.bridge_presence (
  project_id text PRIMARY KEY,
  last_seen timestamptz NOT NULL
);
