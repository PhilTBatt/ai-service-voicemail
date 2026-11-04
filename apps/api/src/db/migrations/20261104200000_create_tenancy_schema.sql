-- migrate:up

-- ─── Shared building blocks ────────────────────────────────────────────────────────────

-- Phone numbers are stored in E.164 form (+447700900123). A domain is a reusable type
-- with its check built in, so every phone column validates the same way.
CREATE DOMAIN e164_phone AS text CHECK (VALUE ~ '^\+[1-9][0-9]{7,14}$');

CREATE DOMAIN email_address AS text CHECK (VALUE ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- The tenant this transaction is acting for, set by withTenant() via
-- set_config('app.tenant_id', id, true). Returns NULL when none is set, so policies match
-- no rows. NULLIF matters: once a connection has had the setting, it reads as '' (not NULL)
-- after the transaction ends, and ''::uuid would be an error instead of "no rows".
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Keeps updated_at honest without relying on every UPDATE statement to set it.
CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Tenants and people ────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name text NOT NULL CHECK (business_name <> ''),
  trade text NOT NULL CHECK (trade IN (
    'plumber', 'electrician', 'heating_engineer', 'roofer', 'locksmith', 'general_builder'
  )),
  status text NOT NULL DEFAULT 'onboarding' CHECK (status IN (
    'onboarding', 'live', 'paused', 'suspended', 'cancelling', 'cancelled', 'demo'
  )),
  -- Nullable until onboarding collects them; Step 11 blocks going live without them.
  notification_mobile e164_phone,
  notification_email email_address,
  -- Decides which gas emergency number the agent gives (BUILD_PLAN Appendix A).
  service_region text NOT NULL DEFAULT 'GB' CHECK (service_region IN ('GB', 'NI')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- People who log in. Not tenant-scoped: one person can belong to several tenants, and
-- admins and resellers work across tenants. No row-level security; the app role gets no
-- access at all, so only the admin module (next change) and Step 10's auth can reach it.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  email email_address NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'reseller')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX ON tenant_memberships (user_id);

-- ─── Numbers and agent configuration ───────────────────────────────────────────────────

CREATE TABLE phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  number e164_phone NOT NULL,
  provider_sid text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);

-- A number can be released and later bought again, so uniqueness only applies while
-- active. The tenant is identified by the number dialled, so this must never be ambiguous.
CREATE UNIQUE INDEX phone_numbers_one_active_per_number ON phone_numbers (number)
  WHERE status = 'active';
-- One dedicated number per tenant.
CREATE UNIQUE INDEX phone_numbers_one_active_per_tenant ON phone_numbers (tenant_id)
  WHERE status = 'active';

-- Every save creates a new version; the agent is synced from the latest one. The jsonb
-- columns hold structured data that the app validates with zod.
CREATE TABLE agent_profiles (
  tenant_id uuid NOT NULL REFERENCES tenants,
  version integer NOT NULL CHECK (version > 0),
  trade_template text NOT NULL,
  services jsonb NOT NULL DEFAULT '[]',
  service_areas jsonb NOT NULL DEFAULT '[]',
  opening_hours jsonb NOT NULL DEFAULT '{}',
  holiday_mode boolean NOT NULL DEFAULT false,
  holiday_until date,
  faqs jsonb NOT NULL DEFAULT '[]',
  emergency_policy jsonb NOT NULL DEFAULT '{}',
  provider_agent_id text,
  synced_at timestamptz,
  sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

-- ─── Calls and what follows from them ──────────────────────────────────────────────────

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  -- Unique across all tenants: a duplicate webhook must never create a second call.
  provider_call_id text NOT NULL UNIQUE,
  caller_number e164_phone, -- NULL when the caller withholds their number
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  billable_seconds integer NOT NULL DEFAULT 0 CHECK (billable_seconds >= 0),
  outcome text,
  urgency text CHECK (urgency IN ('emergency', 'urgent', 'routine', 'spam', 'other')),
  summary text,
  extracted_fields jsonb NOT NULL DEFAULT '{}',
  transcript text,
  recording_ref text,
  via_fallback boolean NOT NULL DEFAULT false,
  flags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Lets child tables reference (tenant_id, id), so a child row can't point at another
  -- tenant's call even by mistake.
  UNIQUE (tenant_id, id)
);

CREATE INDEX ON calls (tenant_id, started_at DESC);

-- One row per cost component (voice platform minutes, telephony, LLM tokens, SMS
-- segments). Prices are applied later, from config (Step 5).
CREATE TABLE call_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  call_id uuid NOT NULL,
  component text NOT NULL,
  units bigint NOT NULL CHECK (units >= 0),
  unit_type text NOT NULL,
  is_estimated boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ON call_costs (tenant_id, call_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  call_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  -- 'blocked' = dropped by the outbound allowlist outside production (Step 6).
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) ON DELETE CASCADE,
  -- A retried job can't send the same notification twice.
  UNIQUE (call_id, channel)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE usage_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end > period_start),
  billable_seconds bigint NOT NULL DEFAULT 0 CHECK (billable_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON usage_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Legal, audit and blocking ─────────────────────────────────────────────────────────

-- Append-only record of who accepted which version of which document.
CREATE TABLE terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  document_type text NOT NULL CHECK (document_type IN ('terms', 'dpa', 'privacy_notice')),
  document_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  accepted_by uuid NOT NULL REFERENCES users
);

CREATE INDEX ON terms_acceptances (tenant_id);

-- Append-only. tenant_id is NULL for actions that aren't about one tenant (such as the
-- kill switch); those rows are only visible through the admin module.
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants,
  actor_user_id uuid REFERENCES users,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON audit_log (tenant_id, created_at DESC);

CREATE TABLE blocked_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  number e164_phone NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

-- ─── Row-level security ────────────────────────────────────────────────────────────────
-- ENABLE turns RLS on. FORCE makes it apply to the table owner too (owners skip it
-- otherwise). With no tenant set, current_tenant_id() is NULL, NULL = anything is never
-- true, so every policy matches nothing: the database refuses by default.
-- A policy's USING clause filters rows for SELECT, UPDATE and DELETE; for a policy without
-- a separate WITH CHECK, the same condition also blocks INSERTs and UPDATEs that would
-- write another tenant's rows.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = current_tenant_id());

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenant_memberships', 'phone_numbers', 'agent_profiles', 'calls', 'call_costs',
    'notifications', 'usage_periods', 'terms_acceptances', 'audit_log', 'blocked_numbers'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id())',
      table_name
    );
  END LOOP;
END
$$;

-- ─── What the app role may do ──────────────────────────────────────────────────────────
-- Least privilege: only what the API needs. Anything else (creating tenants, assigning
-- numbers, reading users) goes through the admin module.

GRANT SELECT, UPDATE ON tenants TO callmate_app;
GRANT SELECT ON tenant_memberships, phone_numbers TO callmate_app;
GRANT SELECT, INSERT, UPDATE ON agent_profiles, calls, notifications, usage_periods TO callmate_app;
GRANT SELECT, INSERT ON call_costs, terms_acceptances TO callmate_app;
GRANT INSERT ON audit_log TO callmate_app;
GRANT SELECT, INSERT, DELETE ON blocked_numbers TO callmate_app;

-- migrate:down

DROP TABLE blocked_numbers, audit_log, terms_acceptances, usage_periods, notifications,
  call_costs, calls, agent_profiles, phone_numbers, tenant_memberships, users, tenants;
DROP TRIGGER set_updated_at ON system_settings;
DROP FUNCTION set_updated_at();
DROP FUNCTION current_tenant_id();
DROP DOMAIN email_address;
DROP DOMAIN e164_phone;
