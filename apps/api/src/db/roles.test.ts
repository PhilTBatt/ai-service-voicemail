import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.ts";
import { TEST_DATABASE_URL, TEST_MIGRATION_DATABASE_URL } from "../testing/databases.ts";
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

describe("the role that runs the migrations", () => {
  // A migration waiting for a lock on a busy table queues every query behind it, call routing
  // included: the owner role gives up after 5 seconds instead (20261111170000_release_safety).
  it("waits at most 5 seconds for a lock, by default, in every new session", async () => {
    const owner = createPool(TEST_MIGRATION_DATABASE_URL.replace("?sslmode=disable", ""));
    try {
      const { rows } = await owner.query<{ lock_timeout: string }>("SHOW lock_timeout");
      expect(rows[0]?.lock_timeout).toBe("5s");
    } finally {
      await owner.end();
    }
  });

  it("leaves the app role without it: a call's own queries keep Postgres's default", async () => {
    const { rows } = await app.query<{ lock_timeout: string }>("SHOW lock_timeout");
    expect(rows[0]?.lock_timeout).toBe("0");
  });
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
