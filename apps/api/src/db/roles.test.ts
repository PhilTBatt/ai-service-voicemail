import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.ts";
import { TEST_DATABASE_URL } from "../testing/databases.ts";
import {
  GLOBAL_SETTINGS_LOCK_TIMEOUT_MS,
  holdGlobalSettings,
} from "../testing/global-settings-lock.ts";

// Connected as the app role, exactly as the API is.
const app = createPool(TEST_DATABASE_URL);

// The kill switch is one setting for the whole service: this file takes its turn with the
// others that change or check it (testing/global-settings-lock.ts).
let releaseGlobalSettings: () => Promise<void>;
beforeAll(async () => {
  releaseGlobalSettings = await holdGlobalSettings();
}, GLOBAL_SETTINGS_LOCK_TIMEOUT_MS);
afterAll(async () => {
  await releaseGlobalSettings();
});

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
