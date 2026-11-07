-- migrate:up

-- SMS delivery receipts (BUILD_PLAN Step 6 follow-up). Twilio reports whether a text reached
-- the handset; 'delivered' and 'undelivered' are what it said, after our 'sent'.
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'blocked', 'delivered', 'undelivered'));
-- The provider's error code when a text wasn't delivered (Twilio's 21610 means the
-- recipient opted out by replying STOP).
ALTER TABLE notifications ADD COLUMN failure_code text;

-- The receipt names only the provider's message ID. Like the other webhook lookups, an
-- owner-run function turns it into a tenant ID and nothing else.
CREATE POLICY owner_notification_lookup ON notifications FOR SELECT TO callmate_owner USING (true);

CREATE FUNCTION tenant_id_for_provider_ref(ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM public.notifications WHERE provider_ref = ref
    ORDER BY created_at DESC LIMIT 1
  $$;

REVOKE EXECUTE ON FUNCTION tenant_id_for_provider_ref(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_id_for_provider_ref(text) TO callmate_app;

CREATE INDEX notifications_provider_ref_idx ON notifications (provider_ref);

-- migrate:down

DROP INDEX notifications_provider_ref_idx;
DROP FUNCTION tenant_id_for_provider_ref(text);
DROP POLICY owner_notification_lookup ON notifications;
ALTER TABLE notifications DROP COLUMN failure_code;
UPDATE notifications SET status = 'sent' WHERE status IN ('delivered', 'undelivered');
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'blocked'));
