-- migrate:up

-- Dashboard login (BUILD_PLAN Step 10). The login provider proves who is calling and hands
-- the API a stable subject ID. The API then needs that person's account: their role and the
-- tenants they belong to. The app role can't read users at all, and sees tenant_memberships
-- only inside a tenant, so, like the webhook lookups, an owner-run function answers the one
-- question and nothing more. One row per membership; a single row with a null tenant_id for
-- an admin or reseller who belongs to no tenant.
CREATE POLICY owner_membership_lookup ON tenant_memberships FOR SELECT TO callmate_owner USING (true);

CREATE FUNCTION account_for_subject(subject text)
  RETURNS TABLE (user_id uuid, email text, role text, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT u.id, u.email::text, u.role, m.tenant_id
    FROM public.users u
    LEFT JOIN public.tenant_memberships m ON m.user_id = u.id
    WHERE u.auth_subject = subject
  $$;

REVOKE EXECUTE ON FUNCTION account_for_subject(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_for_subject(text) TO callmate_app;

-- migrate:down

DROP FUNCTION account_for_subject(text);
DROP POLICY owner_membership_lookup ON tenant_memberships;
