-- migrate:up

-- ─── Webhook lookup: dialled number → tenant ID ────────────────────────────────────────
-- A webhook has to find the tenant before any tenant is set, and the app role can't see
-- phone_numbers without one. This function runs as its owner (SECURITY DEFINER) and returns
-- nothing but the tenant's ID.

-- RLS is forced, so the owner needs its own policy to see numbers across tenants. It's
-- read-only and limited to this table.
CREATE POLICY owner_number_lookup ON phone_numbers FOR SELECT TO callmate_owner USING (true);

-- A fixed search_path (temporary schema last) and the schema-qualified table name stop anyone
-- redirecting the function to a look-alike table (the Postgres docs' advice for SECURITY DEFINER).
CREATE FUNCTION tenant_id_for_number(dialled text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM public.phone_numbers WHERE number = dialled AND status = 'active'
  $$;

-- New functions can be called by everyone (PUBLIC) by default. Only the app role needs this.
REVOKE EXECUTE ON FUNCTION tenant_id_for_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_id_for_number(text) TO callmate_app;

-- ─── Admin role: every tenant, through explicit policies ───────────────────────────────

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants', 'tenant_memberships', 'phone_numbers', 'agent_profiles', 'calls',
    'call_costs', 'notifications', 'usage_periods', 'terms_acceptances', 'audit_log',
    'blocked_numbers'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY admin_all ON %I TO callmate_admin USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END
$$;

-- Read and write data in every table, but no schema changes (it owns nothing) and no
-- access to the migration history.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, tenant_memberships, phone_numbers, agent_profiles, calls, call_costs,
  notifications, usage_periods, terms_acceptances, audit_log, blocked_numbers, system_settings
  TO callmate_admin;

-- migrate:down

REVOKE SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, tenant_memberships, phone_numbers, agent_profiles, calls, call_costs,
  notifications, usage_periods, terms_acceptances, audit_log, blocked_numbers, system_settings
  FROM callmate_admin;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants', 'tenant_memberships', 'phone_numbers', 'agent_profiles', 'calls',
    'call_costs', 'notifications', 'usage_periods', 'terms_acceptances', 'audit_log',
    'blocked_numbers'
  ] LOOP
    EXECUTE format('DROP POLICY admin_all ON %I', table_name);
  END LOOP;
END
$$;

DROP FUNCTION tenant_id_for_number(text);
DROP POLICY owner_number_lookup ON phone_numbers;
