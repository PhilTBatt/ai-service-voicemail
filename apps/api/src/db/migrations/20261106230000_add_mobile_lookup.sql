-- migrate:up

-- ─── Inbound SMS: sender's mobile → tenant ID (BUILD_PLAN Step 6) ──────────────────────
-- A text to the notification number is matched to a tenant by the sender's registered
-- mobile. Like tenant_id_for_number, this runs as the owner and returns only the ID, and
-- only when exactly one tenant has that mobile: an ambiguous match is treated as unknown.

CREATE POLICY owner_mobile_lookup ON tenants FOR SELECT TO callmate_owner USING (true);

CREATE FUNCTION tenant_id_for_mobile(mobile text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END
    FROM public.tenants
    WHERE notification_mobile = mobile AND status <> 'cancelled'
  $$;

REVOKE EXECUTE ON FUNCTION tenant_id_for_mobile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_id_for_mobile(text) TO callmate_app;

-- SMS commands change a tenant's status, so they're audited (decision 006). The app role
-- can add rows but never change or remove them; RLS keeps them inside the tenant.
GRANT SELECT, INSERT ON audit_log TO callmate_app;

-- migrate:down

REVOKE SELECT, INSERT ON audit_log FROM callmate_app;
DROP FUNCTION tenant_id_for_mobile(text);
DROP POLICY owner_mobile_lookup ON tenants;
