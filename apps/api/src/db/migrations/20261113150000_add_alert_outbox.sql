-- migrate:up

-- Alert emails waiting to go (alert-email.ts). Each alert is written here before it's emailed,
-- so one waiting out a Postmark outage or the 15-minute throttle survives a restart or a
-- release: before, it was only in the process's memory (and the log). One row per throttle
-- window: an alert name, or an alert name and a business for the alerts about one business.
-- The API and the worker both raise alerts and both send them; a claim with a short lease stops
-- two processes emailing the same window, and the throttle now holds across both.
--
-- Not tenant data (a tenant ID at most, in the key and the details, as in the logs), so no
-- row-level security, like scheduled_runs. Details are stored already redacted, as the email
-- shows them. A window with nothing waiting is deleted a day after its last email.
CREATE TABLE alert_outbox (
  throttle_key text PRIMARY KEY,
  alert text NOT NULL,
  -- The newest alert's details and time: what the next email shows.
  details jsonb NOT NULL,
  raised_at timestamptz NOT NULL,
  -- Alerts no email has carried yet, and since when the oldest of them has waited.
  unsent integer NOT NULL DEFAULT 0 CHECK (unsent >= 0),
  waiting_since timestamptz,
  -- The last email for this window (or the allowlist turning it away): the 15 minutes run from here.
  sent_at timestamptz,
  -- Sends failed in a row, and when the next may be tried: 1 minute, doubling, at most 15.
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  next_attempt_at timestamptz,
  -- A process sending it now holds it until then; after, another may (one that died mid-send).
  claimed_until timestamptz
);

-- The API and the worker connect as the app role. Nothing else reads it.
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_outbox TO callmate_app;

-- migrate:down

DROP TABLE alert_outbox;
