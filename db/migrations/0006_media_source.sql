-- Persist the canonical public page and part identity, never the expiring CDN URL.
ALTER TABLE yuqu.media_versions ADD COLUMN source jsonb;
ALTER TABLE yuqu.media_versions ADD CONSTRAINT media_source_object CHECK(source IS NULL OR jsonb_typeof(source)='object');
UPDATE yuqu.media_versions m SET source=jsonb_build_object('kind','audio','url',j.source_url)
FROM yuqu.import_jobs j WHERE j.media_version_id=m.id AND m.source IS NULL;
