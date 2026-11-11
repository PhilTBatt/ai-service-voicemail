-- migrate:up

-- When each business was suspended, and when it was resumed (Phil, 2026-11-11: a month a business
-- spends suspended from start to end isn't charged; any month it had the service in, even for a
-- day, is charged as usual). The status column only says what's true now; billing needs what
-- was true on each day of a month that has ended, so each suspension is a row of its own:
-- opened by the admin screen's suspend, closed by its resume (db/billing-actions.ts).
CREATE TABLE tenant_suspensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  started_at timestamptz NOT NULL DEFAULT now(),
  -- NULL while it's still suspended.
  ended_at timestamptz CHECK (ended_at IS NULL OR ended_at >= started_at),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- At most one open suspension per business.
CREATE UNIQUE INDEX tenant_suspensions_open_idx ON tenant_suspensions (tenant_id)
  WHERE ended_at IS NULL;

-- Businesses already suspended: from the suspension the audit log recorded, or from now if it
-- has none. Both tables are read past row-level security for this transaction only, as
-- 20261108090000 did; the new table's own is turned on after.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY;
INSERT INTO tenant_suspensions (tenant_id, started_at)
SELECT t.id, COALESCE(
  (SELECT max(a.created_at) FROM audit_log a
   WHERE a.tenant_id = t.id AND a.action = 'tenant.suspended'),
  now())
FROM tenants t WHERE t.status = 'suspended';
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_suspensions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_suspensions USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON tenant_suspensions TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON tenant_suspensions TO callmate_app;
GRANT SELECT ON tenant_suspensions TO callmate_admin;

-- migrate:down

DROP TABLE tenant_suspensions;
