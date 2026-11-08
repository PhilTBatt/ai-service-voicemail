-- migrate:up

-- The admin's review queue (BUILD_PLAN Step 10): a call the pipeline flagged stays in the queue
-- until an admin marks it reviewed. When and by whom is kept on the call; the audit log records
-- the action as well. A reviewer's user record can go without taking the call with it.
ALTER TABLE calls
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by uuid REFERENCES users ON DELETE SET NULL;

-- The queue asks for calls whose flags overlap the pipeline's review flags (flags && array).
-- A GIN index answers that without reading every call, which matters once there are many.
CREATE INDEX calls_flags_idx ON calls USING gin (flags);

-- migrate:down

DROP INDEX calls_flags_idx;
ALTER TABLE calls DROP COLUMN reviewed_by, DROP COLUMN reviewed_at;
