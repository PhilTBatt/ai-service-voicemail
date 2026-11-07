-- migrate:up

-- Leaving (BUILD_PLAN Step 13). When a business asked to cancel: callers hear "service has
-- ended" for 30 days from then, after which its number can be released. And when its data was
-- deleted, kept with the anonymised business row for the billing records that must stay.
ALTER TABLE tenants ADD COLUMN cancellation_requested_at timestamptz;
ALTER TABLE tenants ADD COLUMN data_deleted_at timestamptz;

-- Businesses already cancelling before this column existed count from now.
UPDATE tenants SET cancellation_requested_at = now() WHERE status = 'cancelling';

-- The messages sent when a business leaves: how to turn its diverts off and get its
-- voicemail back. 'blocked' means the outbound allowlist stopped one outside production.
CREATE TABLE offboarding_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  kind text NOT NULL CHECK (kind IN ('cancellation')),
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  status text NOT NULL CHECK (status IN ('sent', 'blocked')),
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON offboarding_messages (tenant_id, kind);

ALTER TABLE offboarding_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE offboarding_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON offboarding_messages USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON offboarding_messages TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON offboarding_messages TO callmate_app;
GRANT SELECT, DELETE ON offboarding_messages TO callmate_admin;

-- migrate:down

DROP TABLE offboarding_messages;
ALTER TABLE tenants DROP COLUMN data_deleted_at;
ALTER TABLE tenants DROP COLUMN cancellation_requested_at;
