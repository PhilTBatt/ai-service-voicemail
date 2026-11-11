-- migrate:up

-- Two billing fixes (decision 019, 2026-11-11). billing_charges keeps its row-level security
-- and tenant_isolation policy; these are new columns on it, covered by the table's grants.

-- The provider's own time (GoCardless's created_at) on the last payment event applied to the
-- charge. GoCardless sends events out of order, and sends one whose delivery failed again
-- later, after events that happened since. An event older than this is history and is
-- ignored, so a failure redelivered late can't undo the payment's later success. Null until
-- an event is applied, and again when a new payment is made for the month.
ALTER TABLE billing_charges ADD COLUMN last_event_at timestamptz;

-- Which payment for the month the charge is on: 1 for the morning run's, then one more each
-- time a cancelled payment is collected again by hand, as a new payment. Part of that new
-- payment's idempotency key, so pressing Collect again twice makes one payment, not two.
ALTER TABLE billing_charges
  ADD COLUMN collection_attempt integer NOT NULL DEFAULT 1 CHECK (collection_attempt >= 1);

-- migrate:down

ALTER TABLE billing_charges DROP COLUMN collection_attempt;
ALTER TABLE billing_charges DROP COLUMN last_event_at;
