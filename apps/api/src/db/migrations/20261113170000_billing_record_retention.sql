-- migrate:up

-- Billing records are kept 7 years from the end of each billing month (PROGRESS, open question
-- 3), then deleted by the nightly retention run (jobs/retention.ts), which connects as the admin
-- role. It could read these tables but not delete from them. usage_periods it already can.
GRANT DELETE ON billing_charges, billing_emails, payment_events, payment_mandates,
  tenant_suspensions TO callmate_admin;

-- migrate:down

REVOKE DELETE ON billing_charges, billing_emails, payment_events, payment_mandates,
  tenant_suspensions FROM callmate_admin;
