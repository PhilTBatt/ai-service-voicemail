-- migrate:up

-- The data export (BUILD_PLAN Step 13) now names the people who can log in to the business
-- (Phil, 2026-11-11): each one's email and role, and when they were given access. The app role
-- can't read users at all, and should stay that way, so, like account_for_subject, an owner-run
-- function answers this one question and nothing more. It answers only for the business this
-- transaction is acting for (withTenant): asked about any other, or with no business set
-- (current_tenant_id() is then NULL), it returns nothing. No user IDs and no login subjects:
-- those are ours, not the business's.
CREATE FUNCTION tenant_members(tenant uuid)
  RETURNS TABLE (email text, role text, added_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT u.email::text, u.role, m.created_at
    FROM public.tenant_memberships m
    JOIN public.users u ON u.id = m.user_id
    WHERE m.tenant_id = tenant AND tenant = public.current_tenant_id()
    ORDER BY m.created_at, u.email
  $$;

REVOKE EXECUTE ON FUNCTION tenant_members(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_members(uuid) TO callmate_app;

-- migrate:down

DROP FUNCTION tenant_members(uuid);
