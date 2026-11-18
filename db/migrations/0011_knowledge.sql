CREATE TABLE yuqu.saved_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES yuqu.users(id),
  media_version_id text NOT NULL REFERENCES yuqu.media_versions(id),
  request_id uuid NOT NULL,
  request_intent jsonb NOT NULL,
  kind text NOT NULL CHECK(kind IN ('excerpt','answer')),
  source_snapshot jsonb NOT NULL,
  content_snapshot jsonb NOT NULL,
  note text NOT NULL DEFAULT '' CHECK(length(note)<=4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id)
);
CREATE INDEX saved_items_user_page ON yuqu.saved_items(user_id,created_at DESC,id DESC);
CREATE INDEX saved_items_media_page ON yuqu.saved_items(user_id,media_version_id,created_at DESC,id DESC);
