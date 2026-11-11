-- migrate:up

-- When each scheduled job last ran (db/scheduled-runs.ts). pg-boss runs them on their cron, and
-- a job that stops running says nothing: a worker that starts without GoCardless's settings
-- quietly stops charging, and one without Twilio's stops the nightly retention. The worker
-- writes here as each run starts and ends, and checks every few minutes for a job that's
-- overdue; the Admin page shows the same rows. One row per job, not tenant data (no business
-- in it), so no row-level security, like worker_heartbeat.
CREATE TABLE scheduled_runs (
  queue text PRIMARY KEY,
  -- When a worker first scheduled it: the clock for "overdue" until its first success.
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz
);

-- The worker connects as the app role and the API reads as it; the admin module only reads.
-- Neither can delete a row, so a job's history can't be wiped to hide that it stopped.
GRANT SELECT, INSERT, UPDATE ON scheduled_runs TO callmate_app;
GRANT SELECT ON scheduled_runs TO callmate_admin;

-- migrate:down

DROP TABLE scheduled_runs;
