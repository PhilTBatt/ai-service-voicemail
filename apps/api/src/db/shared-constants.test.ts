// The shared package's lists against the database's own CHECK constraints, read from Postgres
// after every migration has run: a status, trade, urgency or onboarding step added on one side
// only would be accepted by the API's validation and refused by the database (or the other way
// round), and that only shows when a real row is written. Reads the catalogue only.
import { ONBOARDING_STATES, TENANT_STATUSES, TRADES, URGENCIES } from "@callmate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool } from "./cross-tenant.ts";

const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await admin.end();
});

/** The values a table's CHECK constraint allows in one column, as Postgres now holds it. */
async function allowedValues(table: string, column: string): Promise<string[]> {
  const { rows } = await admin.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'c' AND c.conrelid = $1::regclass AND a.attname = $2`,
    [table, column],
  );
  expect(rows, `${table}.${column} has one CHECK constraint`).toHaveLength(1);
  return [...rows[0]!.definition.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
}

describe("the shared lists match the database", () => {
  it.each([
    ["tenants", "status", TENANT_STATUSES],
    ["tenants", "trade", TRADES],
    ["tenants", "onboarding_state", ONBOARDING_STATES],
    ["calls", "urgency", URGENCIES],
  ] as const)("%s.%s", async (table, column, list) => {
    expect((await allowedValues(table, column)).sort()).toEqual([...list].sort());
  });
});
