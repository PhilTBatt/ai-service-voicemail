-- migrate:up

-- Recordings that keep failing to delete (jobs/retention.ts). The nightly run took the 200
-- oldest expired recordings, oldest first, so one that could never be deleted (a fallback
-- reference with no Twilio recording ID, say) stayed among the oldest for good: 200 of those
-- would have stopped every newer recording from ever being deleted. Each failure is now counted
-- on the call, the run tries the recordings that have failed least first, and it alerts about
-- one that looks stuck once, rather than every night. calls already has row-level security;
-- new columns come under it like the rest.
--
-- A NOT NULL column with a constant default is only a catalogue change in Postgres 11 and
-- later: no rewrite of the calls table, however big it is.
ALTER TABLE calls
  ADD COLUMN recording_delete_attempts integer NOT NULL DEFAULT 0
    CHECK (recording_delete_attempts >= 0),
  ADD COLUMN recording_delete_alerted_at timestamptz;

-- migrate:down

ALTER TABLE calls
  DROP COLUMN recording_delete_alerted_at,
  DROP COLUMN recording_delete_attempts;
