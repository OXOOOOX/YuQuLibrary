-- Additive: old questions retain their original frozen context and stand alone.
ALTER TABLE yuqu.chat_turns
  ADD COLUMN parent_turn_id uuid REFERENCES yuqu.chat_turns(id),
  ADD COLUMN topic_root_turn_id uuid REFERENCES yuqu.chat_turns(id),
  ADD COLUMN anchor jsonb,
  ADD COLUMN request_intent jsonb;
ALTER TABLE yuqu.chat_turns DROP CONSTRAINT chat_turns_scope_check;
ALTER TABLE yuqu.chat_turns ADD CONSTRAINT chat_turns_scope_check CHECK(scope IN ('near','until','all','selection'));
CREATE INDEX chat_topic ON yuqu.chat_turns(conversation_id,topic_root_turn_id,sequence);

ALTER TABLE yuqu.playback_takeovers
  ADD COLUMN intent text NOT NULL DEFAULT 'takeover' CHECK(intent IN ('takeover','restore')),
  ADD COLUMN expected_playback_session_id uuid,
  ADD COLUMN target_speed double precision,
  ADD COLUMN target_looping boolean;
ALTER TABLE yuqu.playback_takeovers ADD CONSTRAINT restore_requires_complete_intent CHECK (
  intent <> 'restore' OR (expected_playback_session_id IS NOT NULL AND target_media_version_id IS NOT NULL
    AND target_position_ms IS NOT NULL AND target_speed IN (1,1.25,1.5,2) AND target_looping IS NOT NULL));
