-- migrate:up

-- ─── Call page: signed link's call ID → tenant ID (BUILD_PLAN Step 6) ──────────────────
-- A signed link carries only the call ID. The API has to find the tenant before it can open
-- that tenant's transaction, so this works like tenant_id_for_number: owner-run, returns
-- only the tenant ID, nothing about the call itself.

CREATE POLICY owner_call_lookup ON calls FOR SELECT TO callmate_owner USING (true);

CREATE FUNCTION tenant_id_for_call(call uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM public.calls WHERE id = call
  $$;

REVOKE EXECUTE ON FUNCTION tenant_id_for_call(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_id_for_call(uuid) TO callmate_app;

-- migrate:down

DROP FUNCTION tenant_id_for_call(uuid);
DROP POLICY owner_call_lookup ON calls;
