-- migrate:up

-- Two things for safer releases (2026-11-11).
--
-- 1. A migration never holds up calls for long. A migration that alters a busy table (calls,
--    tenants) needs a lock no other transaction holds; while it waits for one, every query on
--    that table queues behind it, call routing included. With this, the role that runs the
--    migrations (this one) gives up after 5 seconds of waiting: the migration fails, the
--    release stops before the apps move to the new image, and it can simply be run again
--    (RUNBOOK section 8). It's the role's own default, so it covers every migration from the
--    next session on without each one remembering it. A role may set its own defaults
--    (Postgres's ALTER ROLE docs), so no superuser is needed.
ALTER ROLE CURRENT_USER SET lock_timeout = '5s';

-- 2. Which build the worker runs (APP_VERSION), with its check-in, so the release check can
--    wait for the new worker rather than taking the old one's check-in for it.
ALTER TABLE worker_heartbeat ADD COLUMN version text;

-- migrate:down

ALTER TABLE worker_heartbeat DROP COLUMN version;
ALTER ROLE CURRENT_USER RESET lock_timeout;
