import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../db.ts";
import { TEST_DATABASE_URL } from "../testing/databases.ts";

// Connected as the app role, exactly as the API is.
const app = createPool(TEST_DATABASE_URL);

afterAll(async () => {
  await app.end();
});

describe("the app role", () => {
  it("isn't a superuser and can't bypass row-level security", async () => {
    const { rows } = await app.query(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows).toEqual([{ rolname: "callmate_app", rolsuper: false, rolbypassrls: false }]);
  });

  it("owns no tables (the owner role does)", async () => {
    const { rows } = await app.query<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(rows.filter((row) => row.tableowner === "callmate_app")).toEqual([]);
    expect(rows).toContainEqual({ tablename: "system_settings", tableowner: "callmate_owner" });
  });

  it("can read system settings but not change them", async () => {
    const { rows } = await app.query("SELECT kill_switch_on FROM system_settings");
    expect(rows).toEqual([{ kill_switch_on: false }]);
    await expect(app.query("UPDATE system_settings SET kill_switch_on = true")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("can't create tables", async () => {
    await expect(app.query("CREATE TABLE sneaky (id int)")).rejects.toThrow(/permission denied/);
  });
});
