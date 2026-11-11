// The seed's data is fictional and fits the schema, and `npm run db:seed` refuses what it must:
// production, and a missing or malformed admin URL. Run as Phil runs it, a separate process; only
// the refusals are run here, which stop before connecting, so this file never races
// seed.test.ts for the seed's fixed rows.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TENANT_STATUSES, TRADES } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL } from "../testing/databases.ts";
import { SEED_TENANTS } from "./seed.ts";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./seed.ts", import.meta.url));

/** Ofcom's drama ranges, as E.164 prefixes (one digit short of the full number where the range is 1,000). */
const DRAMA_PREFIXES = [
  "+447700900", // mobiles, 07700 900000 to 900999
  "+441632960", // no area, 01632 960000 to 960999
  "+442079460", // London, 020 7946 0000 to 0999
  "+441134960", // Leeds, 0113 496 0000 to 0999
  "+441144960",
  "+441154960",
  "+441164960",
  "+441174960",
  "+441184960",
  "+441914980",
  "+442920180",
  "+442896496",
];

const inDramaRange = (number: string) =>
  DRAMA_PREFIXES.some((prefix) => number.startsWith(prefix) && number.length === 13);

describe("SEED_TENANTS", () => {
  it("uses only drama-range numbers, kept to the 990 to 999 band tests leave free", () => {
    for (const seed of SEED_TENANTS) {
      expect(inDramaRange(seed.phoneNumber), seed.phoneNumber).toBe(true);
      expect(Number(seed.phoneNumber.slice(-3)), seed.phoneNumber).toBeGreaterThanOrEqual(990);
      if (seed.notificationMobile) {
        expect(seed.notificationMobile).toMatch(/^\+447700900\d{3}$/);
      }
    }
  });

  it("uses only example.com addresses", () => {
    for (const seed of SEED_TENANTS) {
      if (seed.notificationEmail) expect(seed.notificationEmail).toMatch(/@example\.com$/);
    }
  });

  it("gives each tenant its own ID, number and provider ID", () => {
    for (const field of ["id", "phoneNumber", "providerSid"] as const) {
      const values = SEED_TENANTS.map((seed) => seed[field]);
      expect(new Set(values).size, field).toBe(values.length);
    }
  });

  it("uses a trade and a status the database accepts", () => {
    for (const seed of SEED_TENANTS) {
      expect(TRADES).toContain(seed.trade);
      expect(TENANT_STATUSES).toContain(seed.status);
      // A seed tenant is never live: nothing real should ever be routed to it.
      expect(["demo", "onboarding"]).toContain(seed.status);
    }
  });

  it("uses fixed IDs, so a re-run finds the tenants it made before", () => {
    for (const seed of SEED_TENANTS) {
      expect(seed.id).toMatch(/^00000000-0000-4000-8000-0000000000\d{2}$/);
    }
  });
});

/** Runs the seed with exactly these settings, and nothing from this machine's environment. */
async function seed(settings: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...settings };
  for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  try {
    const { stdout, stderr } = await run(process.execPath, [script], { env });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("npm run db:seed", () => {
  // Fictional data must never reach a real database.
  it("refuses to run with NODE_ENV=production", async () => {
    const result = await seed({
      NODE_ENV: "production",
      ADMIN_DATABASE_URL: TEST_ADMIN_DATABASE_URL,
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("db:seed refuses to run with NODE_ENV=production");
    expect(result.out).not.toContain("Seed complete");
  }, 30_000);

  it("refuses without an admin URL, saying where to set it", async () => {
    const result = await seed({ NODE_ENV: "development" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("db:seed needs ADMIN_DATABASE_URL");
  }, 30_000);

  it("refuses an admin URL that isn't Postgres, without printing it", async () => {
    const result = await seed({ ADMIN_DATABASE_URL: "mysql://admin:zzmarker@localhost/callmate" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("db:seed needs ADMIN_DATABASE_URL");
    expect(result.out).not.toContain("zzmarker");
  }, 30_000);
});
