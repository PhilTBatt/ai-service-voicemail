import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { isGsm7 } from "../core/sms.ts";
import {
  activeNumberFor,
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  findTenantIdsByMobile,
} from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { MOBILE_BANDS, bandMobile } from "../testing/drama-mobiles.ts";
import { applySmsCommand } from "./tenant-commands.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const NOW = new Date("2026-07-15T10:00:00Z"); // 11:00 BST

async function makeTenant(status: "live" | "paused" | "suspended" | "onboarding", versions = 2) {
  const mobile = await bandMobile(admin, MOBILE_BANDS["db/tenant-commands.test.ts"]);
  const tenantId = await createTenant(admin, {
    businessName: "Command Plumbing",
    trade: "plumber",
    notificationMobile: mobile,
  });
  if (status !== "onboarding") {
    await admin.query("UPDATE tenants SET status = $2 WHERE id = $1", [tenantId, status]);
  }
  for (let version = 1; version <= versions; version++) {
    await admin.query(
      `INSERT INTO agent_profiles (tenant_id, version, trade_template, synced_at)
       VALUES ($1, $2, 'plumber', CASE WHEN $2 = 1 THEN now() END)`,
      [tenantId, version],
    );
  }
  return { tenantId, mobile };
}

const state = async (tenantId: string) => {
  const tenant = (
    await admin.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId])
  ).rows[0]!;
  const profiles = (
    await admin.query<{ version: number; holiday_mode: boolean; holiday_until: string | null }>(
      `SELECT version, holiday_mode, to_char(holiday_until, 'YYYY-MM-DD') AS holiday_until
       FROM agent_profiles WHERE tenant_id = $1 ORDER BY version`,
      [tenantId],
    )
  ).rows;
  const audit = (
    await admin.query<{ action: string; details: unknown }>(
      "SELECT action, details FROM audit_log WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    )
  ).rows;
  return { status: tenant.status, profiles, audit };
};

describe("applySmsCommand", () => {
  it("OFF pauses a live tenant and audits it", async () => {
    const { tenantId } = await makeTenant("live");
    const { reply } = await applySmsCommand(app, tenantId, { kind: "off" }, NOW);
    expect(reply).toContain("now OFF");
    expect(await state(tenantId)).toMatchObject({
      status: "paused",
      audit: [{ action: "tenant.paused", details: { via: "sms" } }],
    });
    expect((await applySmsCommand(app, tenantId, { kind: "off" }, NOW)).reply).toContain(
      "already OFF",
    );
  });

  it("ON resumes a paused tenant", async () => {
    const { tenantId } = await makeTenant("paused");
    const { reply } = await applySmsCommand(app, tenantId, { kind: "on" }, NOW);
    expect(reply).toBe("AnswerMate is ON and answering calls.");
    expect((await state(tenantId)).status).toBe("live");
    expect((await applySmsCommand(app, tenantId, { kind: "on" }, NOW)).reply).toBe(
      "AnswerMate is already ON.",
    );
  });

  it.each(["suspended", "onboarding"] as const)(
    "refuses to switch a %s tenant on or off",
    async (status) => {
      const { tenantId } = await makeTenant(status);
      for (const kind of ["on", "off"] as const) {
        const { reply } = await applySmsCommand(app, tenantId, { kind }, NOW);
        expect(reply).toContain("contact support");
      }
      expect((await state(tenantId)).status).toBe(status);
    },
  );

  it("HOLIDAY sets holiday mode on every profile version and asks for a re-sync", async () => {
    const { tenantId } = await makeTenant("live");
    const result = await applySmsCommand(
      app,
      tenantId,
      { kind: "holiday", until: "2026-12-12" },
      NOW,
    );
    expect(result.reply).toContain("until 12 Dec 2026");
    expect(result.resyncProfileVersion).toBe(2);
    expect((await state(tenantId)).profiles).toEqual([
      { version: 1, holiday_mode: true, holiday_until: "2026-12-12" },
      { version: 2, holiday_mode: true, holiday_until: "2026-12-12" },
    ]);

    // ON ends the holiday without touching the status.
    const on = await applySmsCommand(app, tenantId, { kind: "on" }, NOW);
    expect(on.reply).toContain("Holiday mode is off");
    expect(on.resyncProfileVersion).toBe(2);
    expect(await state(tenantId)).toMatchObject({
      status: "live",
      profiles: [
        { version: 1, holiday_mode: false, holiday_until: null },
        { version: 2, holiday_mode: false, holiday_until: null },
      ],
      audit: [{ action: "holiday.set" }, { action: "holiday.ended" }],
    });
  });

  it("STATUS reports the switch, holiday mode and today's calls in UK time", async () => {
    const { tenantId } = await makeTenant("live");
    for (const startedAt of [
      "2026-07-15T06:30:00Z",
      "2026-07-15T09:00:00Z",
      "2026-07-14T22:30:00Z",
    ]) {
      // 23:30 BST on the 14th is before today; the other two are today.
      await admin.query(
        `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at)
         VALUES ($1, $2, $3, $3)`,
        [tenantId, `call_${randomUUID()}`, startedAt],
      );
    }
    const { reply } = await applySmsCommand(app, tenantId, { kind: "status" }, NOW);
    expect(reply).toBe(
      "AnswerMate is ON. Holiday mode is off. Calls today: 2 (2 still need a reply).",
    );
    expect(isGsm7(reply)).toBe(true);
  });

  it("STATUS says holiday mode is off once the holiday's last day has passed", async () => {
    const { tenantId } = await makeTenant("live");
    // Away until 14 July; today (NOW) is the 15th.
    await admin.query(
      "UPDATE agent_profiles SET holiday_mode = true, holiday_until = '2026-07-14' WHERE tenant_id = $1",
      [tenantId],
    );
    expect((await applySmsCommand(app, tenantId, { kind: "status" }, NOW)).reply).toContain(
      "Holiday mode is off.",
    );
  });

  it("STATUS counts today's calls still waiting for a reply: not called back, not spam", async () => {
    const { tenantId } = await makeTenant("live");
    const none = await applySmsCommand(app, tenantId, { kind: "status" }, NOW);
    expect(none.reply).toBe("AnswerMate is ON. Holiday mode is off. Calls today: 0.");

    // Today: one called back, one spam, two open. Yesterday's open call isn't counted.
    for (const [startedAt, urgency, handled] of [
      ["2026-07-15T08:00:00Z", "routine", true],
      ["2026-07-15T08:10:00Z", "spam", false],
      ["2026-07-15T08:20:00Z", "urgent", false],
      ["2026-07-15T08:30:00Z", null, false],
      ["2026-07-14T12:00:00Z", "routine", false],
    ] as const) {
      await admin.query(
        `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, urgency, handled_at)
         VALUES ($1, $2, $3, $3, $4, CASE WHEN $5 THEN now() END)`,
        [tenantId, `call_${randomUUID()}`, startedAt, urgency, handled],
      );
    }
    const { reply } = await applySmsCommand(app, tenantId, { kind: "status" }, NOW);
    expect(reply).toBe(
      "AnswerMate is ON. Holiday mode is off. Calls today: 4 (2 still need a reply).",
    );
    expect(isGsm7(reply)).toBe(true);

    // One left: singular.
    await admin.query(
      "UPDATE calls SET handled_at = now() WHERE tenant_id = $1 AND urgency = 'urgent'",
      [tenantId],
    );
    expect((await applySmsCommand(app, tenantId, { kind: "status" }, NOW)).reply).toBe(
      "AnswerMate is ON. Holiday mode is off. Calls today: 4 (1 still needs a reply).",
    );
  });

  it("HELP and unknown text get fixed replies", async () => {
    const { tenantId } = await makeTenant("live");
    expect((await applySmsCommand(app, tenantId, { kind: "help" }, NOW)).reply).toContain(
      "HOLIDAY 12/12",
    );
    expect((await applySmsCommand(app, tenantId, { kind: "unknown" }, NOW)).reply).toContain(
      "Reply HELP",
    );
    expect(
      (await applySmsCommand(app, tenantId, { kind: "holiday-invalid" }, NOW)).reply,
    ).toContain("date");
  });
});

describe("findTenantIdsByMobile", () => {
  it("finds every business with that mobile, oldest first, and nobody for an unknown one", async () => {
    const { tenantId, mobile } = await makeTenant("live");
    expect(await findTenantIdsByMobile(app, mobile)).toEqual([tenantId]);
    expect(await findTenantIdsByMobile(app, "+447700900000")).toEqual([]);

    // One tradesperson, two trades, one phone: both are theirs (the mobile was confirmed by a
    // code texted to it), so both answer to it.
    const second = await createTenant(admin, {
      businessName: "Same Mobile Ltd",
      trade: "roofer",
      notificationMobile: mobile,
    });
    expect(await findTenantIdsByMobile(app, mobile)).toEqual([tenantId, second]);

    // A business that has left is out of it.
    await admin.query("UPDATE tenants SET status = 'cancelled' WHERE id = $1", [second]);
    expect(await findTenantIdsByMobile(app, mobile)).toEqual([tenantId]);
  });
});

describe("activeNumberFor", () => {
  it("returns the tenant's active number, or null before they have one", async () => {
    const { tenantId } = await makeTenant("live");
    expect(await activeNumberFor(admin, tenantId)).toBeNull();
    const number = "+441632960991"; // the reserved 990-999 range: no other test takes it
    await admin.query(
      "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
      [number],
    );
    await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
    expect(await activeNumberFor(admin, tenantId)).toEqual({
      number,
      providerSid: expect.stringMatching(/^PN/) as unknown,
    });
  });
});
