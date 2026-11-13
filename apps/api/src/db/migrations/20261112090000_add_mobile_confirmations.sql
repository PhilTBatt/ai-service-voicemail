-- migrate:up

-- Confirming a notification mobile by texted code (Phil, 2026-11-11; PROGRESS open question 4).
-- The mobile on a business's Account page was saved as typed: a typo sent that business's call
-- texts to a stranger, and an owner could type another business's mobile into their own, which
-- broke text commands for both. Now a new mobile is texted a 6-digit code, and only takes effect
-- once the code is typed back. One row per code sent; the latest open one is the live one.
-- The code is kept hashed with the business's ID, never in clear.
CREATE TABLE mobile_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  mobile e164_phone NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The open code for a business, and how many it has asked for lately.
CREATE INDEX mobile_confirmations_tenant_idx ON mobile_confirmations (tenant_id, created_at DESC);

ALTER TABLE mobile_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mobile_confirmations USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON mobile_confirmations TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON mobile_confirmations TO callmate_app;
-- The admin deletes them with the rest of a business's personal data (deleteTenantData).
GRANT SELECT, DELETE ON mobile_confirmations TO callmate_admin;

-- A confirmed mobile may belong to two businesses (one tradesperson, two trades), and a text
-- command from it now applies to each. tenant_id_for_mobile, which answered nothing for a shared
-- mobile, stays for the build still running during the release.
CREATE FUNCTION tenant_ids_for_mobile(mobile text) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT id FROM public.tenants
    WHERE notification_mobile = $1 AND status <> 'cancelled'
    ORDER BY created_at
  $$;

REVOKE EXECUTE ON FUNCTION tenant_ids_for_mobile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_ids_for_mobile(text) TO callmate_app;

-- migrate:down

DROP FUNCTION tenant_ids_for_mobile(text);
DROP TABLE mobile_confirmations;
