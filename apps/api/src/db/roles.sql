-- The roles CallMate uses. Run once per database, as an admin:
--   - local Docker runs it automatically the first time each database starts (docker-compose.yml)
--   - CI runs it in a workflow step (.github/workflows/ci.yml)
-- The passwords are local throwaways. Azure's roles are created in Step 8, with no
-- passwords in the repo.
--
-- callmate_owner  runs migrations and owns every table.
-- callmate_app    what the API connects as. It owns nothing, isn't a superuser and can't
--                 bypass row-level security, so tenant isolation always applies to it.
-- callmate_admin  cross-tenant work (admin screens, seeding), used only from
--                 apps/api/src/db/cross-tenant.ts. It sees every tenant through explicit
--                 policies, not by bypassing row-level security.

CREATE ROLE callmate_owner LOGIN PASSWORD 'callmate_owner'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE callmate_app LOGIN PASSWORD 'callmate_app'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE callmate_admin LOGIN PASSWORD 'callmate_admin'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Owning the database lets callmate_owner create tables in its public schema. Other roles
-- can't (Postgres 15+ no longer lets everyone create objects in public).
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO callmate_owner', current_database());
END
$$;
