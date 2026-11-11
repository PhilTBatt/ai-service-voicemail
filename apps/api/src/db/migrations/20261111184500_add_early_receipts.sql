-- migrate:up

-- Delivery receipts that arrive before their message's ID is saved (2026-11-11). Twilio and
-- Postmark name the message only by their own ID, which the send job saves once the provider
-- has answered (jobs/deliver-notification.ts). Twilio can call back within milliseconds, before
-- that save commits, and doesn't reliably retry a status callback, so such a receipt (perhaps an
-- 'undelivered' that should raise an alert) used to be dropped. Now it waits here, and the send
-- job applies it in the same transaction that saves the ID (db/delivery-receipts.ts).
--
-- Not tenant data: the business isn't known when a receipt arrives (that's the point), and a
-- row holds the provider's message ID, its verdict, the provider's error code or bounce type,
-- and which alert to raise: no message content, no number or address, nothing about a person.
-- So no tenant_id and no row-level security, like scheduled_runs. Rows go when they're applied,
-- or after an hour (pruned as each new one is kept): the race lasts milliseconds, and a receipt
-- for a message that isn't a notification (an onboarding text, say) is never matched at all.
CREATE TABLE early_receipts (
  -- Which provider's ID it is: 'sms' (Twilio) or 'email' (Postmark).
  medium text NOT NULL CHECK (medium IN ('sms', 'email')),
  provider_ref text NOT NULL,
  -- Only the final verdicts are kept; the providers' progress reports change nothing.
  status text NOT NULL CHECK (status IN ('delivered', 'undelivered')),
  failure_code text,
  -- The alert an undelivered message raises once it's matched, and what it says besides the
  -- business and the call (an error code, a bounce type).
  alert text,
  alert_details jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (medium, provider_ref)
);

-- For the pruning of old rows.
CREATE INDEX early_receipts_received_at_idx ON early_receipts (received_at);

-- The webhooks (API) keep receipts and the send jobs (worker) take them back, both as the app
-- role. No TRUNCATE (tenant-context-leaks.test.ts), and nothing for the admin role.
GRANT SELECT, INSERT, UPDATE, DELETE ON early_receipts TO callmate_app;

-- migrate:down

DROP TABLE early_receipts;
