-- migrate:up

-- The texts that move onboarding along (BUILD_PLAN Step 11): the divert instructions and the
-- go-live message. Kept per business, so the go-live text goes out once, and so an admin can
-- see what was sent. 'blocked' means the outbound allowlist stopped it outside production.
CREATE TABLE onboarding_texts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  kind text NOT NULL CHECK (kind IN ('divert_instructions', 'go_live')),
  status text NOT NULL CHECK (status IN ('sent', 'blocked')),
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON onboarding_texts (tenant_id, kind);

ALTER TABLE onboarding_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_texts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onboarding_texts USING (tenant_id = current_tenant_id());
CREATE POLICY admin_all ON onboarding_texts TO callmate_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON onboarding_texts TO callmate_app;
GRANT SELECT ON onboarding_texts TO callmate_admin;

-- The code that brings the tradesperson's network voicemail back (Appendix C), kept when the
-- divert instructions go out, for offboarding (Step 13). Null when we don't know their network's.
ALTER TABLE tenants ADD COLUMN voicemail_restore_code text;

-- migrate:down

ALTER TABLE tenants DROP COLUMN voicemail_restore_code;
DROP TABLE onboarding_texts;
