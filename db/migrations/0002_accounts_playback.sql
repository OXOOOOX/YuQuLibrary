CREATE TABLE yuqu.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE yuqu.login_challenges (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'consumed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX login_challenges_email_created ON yuqu.login_challenges (email, created_at DESC);
CREATE INDEX login_challenges_created ON yuqu.login_challenges (created_at);

CREATE TABLE yuqu.device_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  token_hash text NOT NULL UNIQUE,
  client text NOT NULL CHECK (client IN ('web', 'harmony')),
  device_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  revoked_at timestamptz
);
CREATE INDEX device_sessions_user ON yuqu.device_sessions(user_id);

-- This public, generated sample is the only media in this stage.
-- Imported media will require separate user/library ownership checks.
CREATE TABLE yuqu.media_versions (
  id text PRIMARY KEY,
  content_id text NOT NULL,
  title text NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  UNIQUE (id, content_id)
);
INSERT INTO yuqu.media_versions(id, content_id, title, duration_ms)
VALUES ('fixture-pcm-v1', 'yuqu-playback-check-v1', '两分钟播放验证音频', 120000);

CREATE TABLE yuqu.playback_snapshots (
  user_id uuid PRIMARY KEY REFERENCES yuqu.users(id),
  content_id text NOT NULL DEFAULT 'yuqu-playback-check-v1',
  media_version_id text NOT NULL DEFAULT 'fixture-pcm-v1',
  owner_session_id uuid REFERENCES yuqu.device_sessions(id),
  playback_session_id uuid,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  position_ms integer NOT NULL DEFAULT 0 CHECK (position_ms >= 0),
  speed double precision NOT NULL DEFAULT 1 CHECK (speed IN (1, 1.25, 1.5, 2)),
  state text NOT NULL DEFAULT 'paused' CHECK (state IN ('playing', 'paused', 'buffering', 'ended')),
  looping boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (media_version_id, content_id) REFERENCES yuqu.media_versions(id, content_id)
);
CREATE INDEX playback_snapshots_owner ON yuqu.playback_snapshots(owner_session_id);

CREATE TABLE yuqu.playback_takeovers (
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  request_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES yuqu.device_sessions(id),
  expected_generation integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, request_id)
);
CREATE INDEX playback_takeovers_session ON yuqu.playback_takeovers(session_id);

CREATE TABLE yuqu.user_events (
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  revision integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, revision)
);
