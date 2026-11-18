-- Explicit replay positions are part of the idempotent takeover intent.
ALTER TABLE yuqu.playback_takeovers ADD COLUMN target_position_ms integer
  CHECK (target_position_ms IS NULL OR (target_position_ms >= 0 AND target_media_version_id IS NOT NULL));
