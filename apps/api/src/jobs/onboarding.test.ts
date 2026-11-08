import { randomUUID } from "node:crypto";
import { LEGAL_DOCUMENT_TYPES, LEGAL_DOCUMENTS } from "@callmate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import {
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  createUser,
} from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { FakeSmsProvider } from "../providers/sms.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { runOnboardingJob, type OnboardingJobDeps } from "./onboarding.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

// Ofcom's drama range.
const MOBILE = "+447700900611";

function deps(sms: FakeSmsProvider, allowlist = MOBILE): OnboardingJobDeps {
  return {
    pool: app,
    sms,
    outbound: { nodeEnv: "test", allowlist: parseAllowlist(allowlist) },
    dashboardOrigin: "https://app.example.com",
  };
}

/** A business at a given onboarding step, with a number unless told otherwise. */
async function business(
  state: string,
  { network = "o2", withNumber = true, isTest = false, isPilot = false } = {},
) {
  const tenantId = await createTenant(admin, {
    businessName: "Wren Plumbing",
    trade: "plumber",
    contactName: "Sam",
    notificationMobile: MOBILE,
  });
  await admin.query(
    "UPDATE tenants SET onboarding_state = $2, mobile_network = $3, is_test = $4, is_pilot = $5 WHERE id = $1",
    [tenantId, state, network, isTest, isPilot],
  );
  if (!withNumber) return { tenantId, number: null };
  const number = `+441632960${String(Math.floor(Math.random() * 990)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  return { tenantId, number };
}

/**
 * Everything the go-live rule looks at, short of the flags: terms accepted, the divert
 * instructions sent, and a call after them (or, if told, a call before them, which doesn't count).
 */
async function readyToGoLive(tenantId: string, { callBeforeInstructions = false } = {}) {
  const signer = await createUser(admin, {
    email: `wren-${randomUUID()}@example.com`,
    role: "owner",
  });
  for (const type of LEGAL_DOCUMENT_TYPES) {
    await admin.query(
      "INSERT INTO terms_acceptances (tenant_id, document_type, document_version, accepted_by) VALUES ($1, $2, $3, $4)",
      [tenantId, type, LEGAL_DOCUMENTS[type].version, signer],
    );
  }
  await admin.query(
    `INSERT INTO audit_log (tenant_id, action, details, created_at)
     VALUES ($1, 'onboarding.advanced', '{"to": "divert_instructions_sent"}', now() - interval '1 minute')`,
    [tenantId],
  );
  await admin.query(
    "INSERT INTO calls (tenant_id, provider_call_id, started_at) VALUES ($1, $2, now() - $3::interval)",
    [tenantId, `CA${randomUUID()}`, callBeforeInstructions ? "2 minutes" : "0 minutes"],
  );
}

const tenantRow = async (tenantId: string) =>
  (
    await admin.query<{
      onboarding_state: string;
      status: string;
      voicemail_restore_code: string | null;
    }>("SELECT onboarding_state, status, voicemail_restore_code FROM tenants WHERE id = $1", [
      tenantId,
    ])
  ).rows[0]!;

const texts = async (tenantId: string) =>
  (
    await admin.query<{ kind: string; status: string }>(
      "SELECT kind, status FROM onboarding_texts WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    )
  ).rows;

describe("the send-divert-instructions action", () => {
  it("texts the codes for the network, keeps the restore code, and moves the business on", async () => {
    const { tenantId, number } = await business("agent_synced", { network: "o2" });
    const sms = new FakeSmsProvider();

    expect(
      await runOnboardingJob(deps(sms), { tenantId, action: "send-divert-instructions" }),
    ).toBe("sent");
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe(MOBILE);
    expect(sms.sent[0]!.body).toContain(`dial **61*${number}*11*20# and press call`);
    expect(sms.sent[0]!.body).toContain(`https://app.example.com/tenants/${tenantId}/phone`);
    expect(await tenantRow(tenantId)).toMatchObject({
      onboarding_state: "divert_instructions_sent",
      voicemail_restore_code: "**61*901#",
    });

    // Sending again (a lost text) is fine, and moves nothing.
    expect(
      await runOnboardingJob(deps(sms), { tenantId, action: "send-divert-instructions" }),
    ).toBe("sent");
    expect(sms.sent).toHaveLength(2);
    expect((await tenantRow(tenantId)).onboarding_state).toBe("divert_instructions_sent");
    expect(await texts(tenantId)).toEqual([
      { kind: "divert_instructions", status: "sent" },
      { kind: "divert_instructions", status: "sent" },
    ]);
  });

  it("sends nothing, records 'blocked' and moves nothing when the mobile isn't on the allowlist", async () => {
    const { tenantId } = await business("agent_synced");
    const sms = new FakeSmsProvider();
    expect(
      await runOnboardingJob(deps(sms, "+447700900999"), {
        tenantId,
        action: "send-divert-instructions",
      }),
    ).toBe("blocked");
    expect(sms.sent).toHaveLength(0);
    expect((await tenantRow(tenantId)).onboarding_state).toBe("agent_synced");
    expect(await texts(tenantId)).toEqual([{ kind: "divert_instructions", status: "blocked" }]);
  });

  it("won't send instructions for a business without a number", async () => {
    const { tenantId } = await business("agent_synced", { withNumber: false });
    const sms = new FakeSmsProvider();
    expect(
      await runOnboardingJob(deps(sms), { tenantId, action: "send-divert-instructions" }),
    ).toBe("missing-number-or-mobile");
    expect(sms.sent).toHaveLength(0);
  });
});

describe("the go-live action", () => {
  it("takes a business live after its test call when the rule allows, and texts it once", async () => {
    const { tenantId } = await business("test_call_received", { isTest: true, isPilot: true });
    await readyToGoLive(tenantId);
    const sms = new FakeSmsProvider();

    expect(await runOnboardingJob(deps(sms), { tenantId, action: "go-live" })).toBe("sent");
    expect(await tenantRow(tenantId)).toMatchObject({ onboarding_state: "live", status: "live" });
    expect(sms.sent.map((text) => text.body)).toEqual([
      "AnswerMate is live for Wren Plumbing. Calls you don't answer now go to your assistant, and you'll get a text about each one.",
    ]);

    expect(await runOnboardingJob(deps(sms), { tenantId, action: "go-live" })).toBe("already-sent");
    expect(sms.sent).toHaveLength(1);
    // The step to live, taken by the system (the fixture's own row is the instructions step).
    const audit = await admin.query<{ actor_user_id: string | null; details: { via: string } }>(
      "SELECT actor_user_id, details FROM audit_log WHERE tenant_id = $1 AND action = 'onboarding.advanced' AND details->>'to' = 'live'",
      [tenantId],
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: null,
        details: expect.objectContaining({ via: "automatic", to: "live" }) as unknown,
      },
    ]);
  });

  it("waits, and texts nothing, when the go-live rule says not yet", async () => {
    // Not a test business, and the documents are still placeholders.
    const { tenantId } = await business("test_call_received", { isPilot: true });
    await readyToGoLive(tenantId);
    const sms = new FakeSmsProvider();
    expect(await runOnboardingJob(deps(sms), { tenantId, action: "go-live" })).toBe("not-ready");
    expect(await tenantRow(tenantId)).toMatchObject({
      onboarding_state: "test_call_received",
      status: "onboarding",
    });
    expect(sms.sent).toHaveLength(0);
  });

  it("still texts when an admin takes the business live at the same moment", async () => {
    const { tenantId } = await business("test_call_received", { isTest: true, isPilot: true });
    await readyToGoLive(tenantId);
    const sms = new FakeSmsProvider();
    // The admin's step lands between the job reading the business and taking the step itself.
    const advance: OnboardingJobDeps["advance"] = async () => {
      await admin.query(
        "UPDATE tenants SET onboarding_state = 'live', status = 'live' WHERE id = $1",
        [tenantId],
      );
      return { outcome: "refused", reason: "It's already live" };
    };
    expect(await runOnboardingJob({ ...deps(sms), advance }, { tenantId, action: "go-live" })).toBe(
      "sent",
    );
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.body).toContain("AnswerMate is live");
  });

  it("won't take a call from before the divert instructions as the test call", async () => {
    const { tenantId } = await business("test_call_received", { isTest: true, isPilot: true });
    await readyToGoLive(tenantId, { callBeforeInstructions: true });
    expect(
      await runOnboardingJob(deps(new FakeSmsProvider()), { tenantId, action: "go-live" }),
    ).toBe("not-ready");
  });

  it("texts a business an admin took live by hand", async () => {
    const { tenantId } = await business("live");
    await admin.query("UPDATE tenants SET status = 'live' WHERE id = $1", [tenantId]);
    const sms = new FakeSmsProvider();
    expect(await runOnboardingJob(deps(sms), { tenantId, action: "go-live" })).toBe("sent");
    expect(sms.sent).toHaveLength(1);
  });
});
