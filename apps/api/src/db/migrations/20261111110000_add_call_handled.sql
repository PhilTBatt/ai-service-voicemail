-- migrate:up

-- "Called back": the tradesperson marks a call dealt with, from the page a text links to or
-- from the dashboard, and the call list and the STATUS text can say how many still need a
-- reply. When, and by whom when it was done logged in (the page behind a text's link has no
-- login, so that's NULL there); the audit log records each change as well. A user record can go
-- without taking the call with it, as for reviewed_by.
ALTER TABLE calls
  ADD COLUMN handled_at timestamptz,
  ADD COLUMN handled_by uuid REFERENCES users ON DELETE SET NULL;

-- The call list's "needs a reply" view: a business's open calls, newest first.
CREATE INDEX calls_open_idx ON calls (tenant_id, started_at DESC) WHERE handled_at IS NULL;

-- migrate:down

DROP INDEX calls_open_idx;
ALTER TABLE calls DROP COLUMN handled_by, DROP COLUMN handled_at;
