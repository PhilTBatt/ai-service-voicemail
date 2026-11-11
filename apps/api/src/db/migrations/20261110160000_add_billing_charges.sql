-- migrate:up

-- What each business was charged for each billing month (BUILD_PLAN Step 12; decision 019),
-- worked out the morning after the month ends (jobs/charge-periods.ts). One row per business
-- per month, made before anything is asked of the payments provider, so a run that stops
-- part-way is finished by the next, never doubled. Integer pence throughout, ex VAT and VAT
-- kept apart, and the receipt's own lines as they were worked out.
CREATE TABLE billing_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end > period_start),
  -- 0 for the first month after going live: the pilot's price counts by it.
  period_index integer NOT NULL CHECK (period_index >= 0),
  billable_seconds bigint NOT NULL CHECK (billable_seconds >= 0),
  fee_pence integer NOT NULL CHECK (fee_pence >= 0),
  overage_minutes integer NOT NULL CHECK (overage_minutes >= 0),
  overage_pence integer NOT NULL CHECK (overage_pence >= 0),
  vat_rate_percent integer NOT NULL CHECK (vat_rate_percent >= 0),
  vat_pence integer NOT NULL CHECK (vat_pence >= 0),
  total_pence integer NOT NULL CHECK (total_pence = fee_pence + overage_pence + vat_pence),
  vat_number text,
  lines jsonb NOT NULL,
  -- nothing_due: £0 (a pilot's free month inside its minutes). below_minimum: owed, but less
  -- than the provider will collect (£1), so recorded and not collected. no_mandate: owed, but
  -- there's no usable Direct Debit to collect from; tried again each morning. collecting: the
  -- row is made and the payment is being asked for. The rest are the payment's own progress
  -- at the provider.
  status text NOT NULL CHECK (status IN (
    'nothing_due', 'below_minimum', 'no_mandate', 'collecting', 'pending', 'submitted',
    'confirmed', 'paid_out', 'failed', 'cancelled', 'charged_back'
  )),
  payment_ref text UNIQUE,
  -- The day the provider collects the money, as it said when the payment was made.
  charge_date date,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing_charges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE billing_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_charges USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON billing_charges TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON billing_charges TO callmate_app;
GRANT SELECT ON billing_charges TO callmate_admin;

-- The billing emails: a receipt for each charge, a note when a payment fails, and one when a
-- Direct Debit ends. One per thing, by what it's about, so a retried job never sends twice.
CREATE TABLE billing_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  kind text NOT NULL CHECK (kind IN ('receipt', 'payment_failed', 'direct_debit_ended')),
  -- The charge's ID for a receipt or a failed payment; the mandate's reference for an ending.
  ref text NOT NULL,
  -- blocked: the outbound allowlist outside production. no_email: the business has none set.
  -- refused: the email provider turned the address down for good.
  status text NOT NULL CHECK (status IN ('sent', 'blocked', 'no_email', 'refused')),
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref)
);

ALTER TABLE billing_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_emails USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON billing_emails TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON billing_emails TO callmate_app;
GRANT SELECT ON billing_emails TO callmate_admin;

-- A payment's webhook names the payment: the lookup now finds a business by that too.
CREATE POLICY owner_payment_lookup ON billing_charges FOR SELECT TO callmate_owner USING (true);

CREATE OR REPLACE FUNCTION tenant_id_for_payment_ref(ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM (
      SELECT tenant_id FROM public.payment_mandates WHERE setup_ref = ref OR mandate_ref = ref
      UNION ALL
      SELECT tenant_id FROM public.billing_charges WHERE payment_ref = ref
    ) found
    LIMIT 1
  $$;

-- migrate:down

CREATE OR REPLACE FUNCTION tenant_id_for_payment_ref(ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM public.payment_mandates WHERE setup_ref = ref OR mandate_ref = ref
    LIMIT 1
  $$;
DROP POLICY owner_payment_lookup ON billing_charges;
DROP TABLE billing_emails;
DROP TABLE billing_charges;
