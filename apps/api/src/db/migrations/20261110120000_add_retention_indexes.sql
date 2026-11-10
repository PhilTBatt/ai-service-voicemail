-- migrate:up

-- The nightly retention run (jobs/retention.ts) looks for old calls across every tenant: the
-- ones still holding a recording, and the ones still holding a transcript, summary or
-- extracted fields. The only index on calls starts with tenant_id, so each of those was a
-- scan of the whole table, growing with every call ever taken. These two cover only the rows
-- retention still has work on (once a row is cleared it leaves the index), so each night's
-- lookup reads about as many rows as it clears, however big the table gets.
CREATE INDEX calls_recording_retention_idx ON calls (started_at)
  WHERE recording_ref IS NOT NULL;

CREATE INDEX calls_content_retention_idx ON calls (started_at)
  WHERE transcript IS NOT NULL OR summary IS NOT NULL OR extracted_fields <> '{}';

-- migrate:down

DROP INDEX calls_content_retention_idx;
DROP INDEX calls_recording_retention_idx;
