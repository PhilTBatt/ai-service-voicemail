-- migrate:up

-- Appendix A's {Name}: the tradesperson the caller is told will ring them back. Nullable
-- until onboarding collects it; the sync job refuses to build an agent without it.
ALTER TABLE tenants ADD COLUMN contact_name text CHECK (contact_name <> '');

-- migrate:down

ALTER TABLE tenants DROP COLUMN contact_name;
