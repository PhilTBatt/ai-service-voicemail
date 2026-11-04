// Connection strings for the Docker test database (npm run db:up). CI sets both variables
// to point at its own Postgres service.

/** The restricted app role: what the API connects as, so row-level security applies. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://callmate_app:callmate_app@127.0.0.1:5433/callmate_test";

/** The owner role, used only to run migrations. */
export const TEST_MIGRATION_DATABASE_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ??
  "postgres://callmate_owner:callmate_owner@127.0.0.1:5433/callmate_test?sslmode=disable";
