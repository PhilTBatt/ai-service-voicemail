-- migrate:up

-- Direct Debit (BUILD_PLAN Step 12; decision 019). One row per time a business is sent to
-- the payments provider's page to set one up: 'pending' until they finish (or give up), then
-- 'active' with the mandate to collect against, until it's cancelled or fails. History is kept;
-- at most one is active per business.
CREATE TABLE payment_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  -- The provider's reference for the set-up (GoCardless: the billing request, BRQ...).
  setup_ref text NOT NULL UNIQUE,
  -- Where the person is sent, and until when it works (GoCardless: seven days).
  authorisation_url text NOT NULL,
  expires_at timestamptz NOT NULL,
  -- The mandate (MD...), once the set-up is complete.
  mandate_ref text UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'abandoned', 'cancelled', 'failed')),
  -- The provider's reason when a mandate ends ("bank_account_closed", "mandate_cancelled"...).
  end_reason text,
  activated_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active') = (mandate_ref IS NOT NULL AND ended_at IS NULL AND activated_at IS NOT NULL))
);

CREATE UNIQUE INDEX payment_mandates_one_active ON payment_mandates (tenant_id) WHERE status = 'active';
CREATE INDEX ON payment_mandates (tenant_id, created_at DESC);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_mandates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE payment_mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_mandates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_mandates USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON payment_mandates TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON payment_mandates TO callmate_app;
GRANT SELECT ON payment_mandates TO callmate_admin;

-- Each provider event handled, by the provider's event ID: it delivers at least once, so a
-- repeat is recognised and skipped. Kept as the record of what the provider told us.
CREATE TABLE payment_events (
  event_id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants,
  resource_type text NOT NULL,
  action text NOT NULL,
  cause text,
  resource_ref text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON payment_events (tenant_id, received_at DESC);

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_events USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON payment_events TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON payment_events TO callmate_app;
GRANT SELECT ON payment_events TO callmate_admin;

-- A provider webhook names only its own references. Like the other webhook lookups, an
-- owner-run function turns one into a tenant ID and nothing else.
CREATE POLICY owner_payment_lookup ON payment_mandates FOR SELECT TO callmate_owner USING (true);

CREATE FUNCTION tenant_id_for_payment_ref(ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM public.payment_mandates WHERE setup_ref = ref OR mandate_ref = ref
    LIMIT 1
  $$;

REVOKE EXECUTE ON FUNCTION tenant_id_for_payment_ref(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_id_for_payment_ref(text) TO callmate_app;

-- migrate:down

DROP FUNCTION tenant_id_for_payment_ref(text);
DROP TABLE payment_events;
DROP TABLE payment_mandates;
