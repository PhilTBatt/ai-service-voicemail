-- migrate:up

-- The worker's check-in (BUILD_PLAN Step 14): it writes the time here every 30 seconds, so the
-- admin's health panel, GET /healthz/worker and npm run demo:profile can tell a worker that's
-- down from one that's busy. Without it, a stopped worker was silent: profile changes never
-- reached the voice platform, and no summaries or texts went out. One row, like
-- system_settings. Not tenant data, so no row-level security.
CREATE TABLE worker_heartbeat (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  seen_at timestamptz NOT NULL,
  -- When the worker that last checked in started: a restart shows as a recent time.
  started_at timestamptz NOT NULL
);

-- The worker connects as the app role, and the API reads it for /healthz/worker; the admin
-- module only reads it. Neither can delete it.
GRANT SELECT, INSERT, UPDATE ON worker_heartbeat TO callmate_app;
GRANT SELECT ON worker_heartbeat TO callmate_admin;

-- migrate:down

DROP TABLE worker_heartbeat;
