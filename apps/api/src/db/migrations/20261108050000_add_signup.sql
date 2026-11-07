-- migrate:up

-- Signing up (BUILD_PLAN Step 11). An admin or the reseller makes a single-use link and sends
-- it to a tradesperson; following it creates their business. Only a hash of the link's code is
-- kept: the code itself is shown once, when the link is made.
CREATE TABLE signup_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users,
  -- A business for trying the service out: it may go live while the legal documents are
  -- still placeholders (BUILD_PLAN Step 11: "only test tenants can complete onboarding").
  for_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  tenant_id uuid REFERENCES tenants,
  CHECK ((used_at IS NULL) = (tenant_id IS NULL))
);

-- A link exists before its business does, and only the admin module reads and writes it; the
-- app role has no grant at all. Once used, though, a link names its business, so it gets the
-- same row-level security as every table with a tenant_id (CLAUDE.md).
ALTER TABLE signup_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signup_links USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON signup_links TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON signup_links TO callmate_admin;

-- What the signup form collects about the tradesperson's phone, for the divert instructions
-- (Appendix C) and, at offboarding, restoring their network voicemail.
ALTER TABLE tenants ADD COLUMN mobile_network text CHECK (mobile_network IN (
  'ee', 'o2', 'vodafone', 'three', 'giffgaff', 'tesco_mobile', 'sky_mobile', 'voxi', 'lebara',
  'lyca', 'bt_mobile', 'id_mobile', 'smarty', 'other'
));
ALTER TABLE tenants ADD COLUMN uses_network_voicemail boolean;
ALTER TABLE tenants ADD COLUMN is_test boolean NOT NULL DEFAULT false;

-- migrate:down

ALTER TABLE tenants DROP COLUMN is_test;
ALTER TABLE tenants DROP COLUMN uses_network_voicemail;
ALTER TABLE tenants DROP COLUMN mobile_network;
DROP TABLE signup_links;
