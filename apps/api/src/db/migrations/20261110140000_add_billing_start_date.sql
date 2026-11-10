-- migrate:up

-- The UK date a business went live: its billing periods are months on this anniversary
-- (decision 019), so its usage and its charges line up from day one. Set the moment the
-- business goes live (db/onboarding.ts). Null until then, and for demo businesses, whose
-- calls are never billed; usage then falls back to UK calendar months, as before.
ALTER TABLE tenants ADD COLUMN billing_start_date date;

-- Businesses that were live before this existed keep calendar months until they're given a
-- date by hand, which is only the demo line today.

-- migrate:down

ALTER TABLE tenants DROP COLUMN billing_start_date;
