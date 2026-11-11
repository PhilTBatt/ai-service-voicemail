-- migrate:up

-- Delivery receipts for every message we send a business, not only a call's text or email
-- (2026-11-11, the overnight audit's first watch-list item). The delivery webhooks found a
-- message's business through tenant_id_for_provider_ref, which read only notifications: so an
-- onboarding text, a cancellation text or email, a billing email or the written confirmation of
-- a deletion that bounced was "a message we don't know", kept in early_receipts for an hour and
-- then dropped, and nobody was told.
--
-- Where each of those keeps the provider's message ID:
--   onboarding_texts.provider_ref       the divert instructions and the go-live text
--   offboarding_messages.provider_ref   the cancellation text and email
--   billing_emails.provider_ref         receipts, failed payments, ended Direct Debits
--   audit_log 'tenant.deletion-confirmed', details->>'providerRef'
--                                       the deletion's written confirmation, by email or text

-- What the provider said became of each message, beside our own 'sent'. Columns of their own,
-- not new values of status as on notifications: the jobs read status = 'sent' to send each of
-- these once (the go-live text, each cancellation notice), and a 'delivered' there would send
-- it again. NULL until a final verdict comes; failure_code is Twilio's error code or Postmark's
-- bounce type ('HardBounce', 'SpamComplaint'), never the message or the address.
ALTER TABLE onboarding_texts
  ADD COLUMN delivery_status text CHECK (delivery_status IN ('delivered', 'undelivered')),
  ADD COLUMN failure_code text;
ALTER TABLE offboarding_messages
  ADD COLUMN delivery_status text CHECK (delivery_status IN ('delivered', 'undelivered')),
  ADD COLUMN failure_code text;
ALTER TABLE billing_emails
  ADD COLUMN delivery_status text CHECK (delivery_status IN ('delivered', 'undelivered')),
  ADD COLUMN failure_code text;

-- The webhooks (as the app role, inside the business's transaction) write the verdict and
-- nothing else: only these two columns, so the rows that say what was sent stay as written.
-- Locking the row while it's read (SELECT ... FOR UPDATE) needs this too.
GRANT UPDATE (delivery_status, failure_code) ON onboarding_texts TO callmate_app;
GRANT UPDATE (delivery_status, failure_code) ON offboarding_messages TO callmate_app;
GRANT UPDATE (delivery_status, failure_code) ON billing_emails TO callmate_app;

-- Every receipt is looked up by the provider's ID, in each of these.
CREATE INDEX onboarding_texts_provider_ref_idx ON onboarding_texts (provider_ref);
CREATE INDEX offboarding_messages_provider_ref_idx ON offboarding_messages (provider_ref);
CREATE INDEX billing_emails_provider_ref_idx ON billing_emails (provider_ref);
CREATE INDEX audit_log_deletion_confirmation_ref_idx ON audit_log ((details ->> 'providerRef'))
  WHERE action = 'tenant.deletion-confirmed';

-- The lookup reads past row-level security, as the owner, like the others. On the audit log,
-- only the deletion confirmations: nothing else there is any receipt's business.
CREATE POLICY owner_receipt_lookup ON onboarding_texts FOR SELECT TO callmate_owner USING (true);
CREATE POLICY owner_receipt_lookup ON offboarding_messages FOR SELECT TO callmate_owner
  USING (true);
CREATE POLICY owner_receipt_lookup ON billing_emails FOR SELECT TO callmate_owner USING (true);
CREATE POLICY owner_receipt_lookup ON audit_log FOR SELECT TO callmate_owner
  USING (action = 'tenant.deletion-confirmed');

-- Still the business's ID and nothing else, now from wherever the message is kept. Replacing
-- the function keeps its owner and its grants (only the app role may run it). The ID is
-- written $1, not by its name: billing_emails has a column called ref, and in a SQL function a
-- column wins over a parameter of the same name, so "provider_ref = ref" there would compare
-- the row with itself and find nothing.
CREATE OR REPLACE FUNCTION tenant_id_for_provider_ref(ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM (
      SELECT tenant_id, created_at FROM public.notifications WHERE provider_ref = $1
      UNION ALL
      SELECT tenant_id, created_at FROM public.onboarding_texts WHERE provider_ref = $1
      UNION ALL
      SELECT tenant_id, created_at FROM public.offboarding_messages WHERE provider_ref = $1
      UNION ALL
      SELECT tenant_id, created_at FROM public.billing_emails WHERE provider_ref = $1
      UNION ALL
      SELECT tenant_id, created_at FROM public.audit_log
      WHERE action = 'tenant.deletion-confirmed' AND details ->> 'providerRef' = $1
    ) sent
    ORDER BY created_at DESC LIMIT 1
  $$;

-- migrate:down

CREATE OR REPLACE FUNCTION tenant_id_for_provider_ref(ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM public.notifications WHERE provider_ref = ref
    ORDER BY created_at DESC LIMIT 1
  $$;
DROP POLICY owner_receipt_lookup ON audit_log;
DROP POLICY owner_receipt_lookup ON billing_emails;
DROP POLICY owner_receipt_lookup ON offboarding_messages;
DROP POLICY owner_receipt_lookup ON onboarding_texts;
DROP INDEX audit_log_deletion_confirmation_ref_idx;
DROP INDEX billing_emails_provider_ref_idx;
DROP INDEX offboarding_messages_provider_ref_idx;
DROP INDEX onboarding_texts_provider_ref_idx;
REVOKE UPDATE (delivery_status, failure_code) ON billing_emails FROM callmate_app;
REVOKE UPDATE (delivery_status, failure_code) ON offboarding_messages FROM callmate_app;
REVOKE UPDATE (delivery_status, failure_code) ON onboarding_texts FROM callmate_app;
ALTER TABLE billing_emails DROP COLUMN failure_code, DROP COLUMN delivery_status;
ALTER TABLE offboarding_messages DROP COLUMN failure_code, DROP COLUMN delivery_status;
ALTER TABLE onboarding_texts DROP COLUMN failure_code, DROP COLUMN delivery_status;
