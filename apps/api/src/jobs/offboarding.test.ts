import { afterAll, describe, expect, it } from "vitest";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { FakeEmailProvider } from "../providers/email.fake.ts";
import { FakeSmsProvider } from "../providers/sms.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { runOffboardingJob, type OffboardingJobDeps } from "./offboarding.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

// Ofcom's drama range, and an example.com address.
const MOBILE = "+447700900641";
const EMAIL = "sam@example.com";

function deps(
  sms: FakeSmsProvider,
  email: FakeEmailProvider | undefined,
  allowlist = `${MOBILE},${EMAIL}`,
): OffboardingJobDeps {
  return {
    pool: app,
    sms,
    email,
    outbound: { nodeEnv: "test", allowlist: parseAllowlist(allowlist) },
  };
}

async function leavingBusiness(network: string | null, restoreCode: string | null = null) {
  const tenantId = await createTenant(admin, {
    businessName: "Leaving Plumbing",
    trade: "plumber",
    notificationMobile: MOBILE,
    notificationEmail: EMAIL,
  });
  await admin.query(
    "UPDATE tenants SET status = 'cancelling', cancellation_requested_at = now(), mobile_network = $2, voicemail_restore_code = $3 WHERE id = $1",
    [tenantId, network, restoreCode],
  );
  return tenantId;
}

const messages = async (tenantId: string) =>
  (
    await admin.query<{ channel: string; status: string }>(
      "SELECT channel, status FROM offboarding_messages WHERE tenant_id = $1 ORDER BY channel",
      [tenantId],
    )
  ).rows;

describe("the cancellation-notices action", () => {
  it("texts and emails how to turn the diverts off and get voicemail back, once each", async () => {
    const tenantId = await leavingBusiness("vodafone");
    const sms = new FakeSmsProvider();
    const email = new FakeEmailProvider();

    expect(
      await runOffboardingJob(deps(sms, email), { tenantId, action: "cancellation-notices" }),
    ).toEqual({
      sms: "sent",
      email: "sent",
    });
    expect(sms.sent[0]!.to).toBe(MOBILE);
    expect(sms.sent[0]!.body).toContain("**61*121*11*30#");
    expect(email.sent[0]!.to).toBe(EMAIL);
    expect(email.sent[0]!.subject).toBe("Your AnswerMate service has been cancelled");

    // A retry (or a second cancellation job) sends nothing again.
    expect(
      await runOffboardingJob(deps(sms, email), { tenantId, action: "cancellation-notices" }),
    ).toEqual({
      sms: "already-sent",
      email: "already-sent",
    });
    expect(sms.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    expect(await messages(tenantId)).toEqual([
      { channel: "email", status: "sent" },
      { channel: "sms", status: "sent" },
    ]);
  });

  it("uses the restore code kept with the divert instructions over the network's", async () => {
    const tenantId = await leavingBusiness("three", "**61*+447700900999*11*30#");
    const sms = new FakeSmsProvider();
    await runOffboardingJob(deps(sms, undefined), { tenantId, action: "cancellation-notices" });
    expect(sms.sent[0]!.body).toContain(
      "dial **61*+447700900999*11*30# to get your voicemail back",
    );
  });

  it("records each blocked message and sends nothing outside the allowlist", async () => {
    const tenantId = await leavingBusiness("o2");
    const sms = new FakeSmsProvider();
    const email = new FakeEmailProvider();
    expect(
      await runOffboardingJob(deps(sms, email, "+447700900998"), {
        tenantId,
        action: "cancellation-notices",
      }),
    ).toEqual({ sms: "blocked", email: "blocked" });
    expect(sms.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(await messages(tenantId)).toEqual([
      { channel: "email", status: "blocked" },
      { channel: "sms", status: "blocked" },
    ]);
  });

  it("still texts where email isn't set up", async () => {
    const tenantId = await leavingBusiness(null);
    const sms = new FakeSmsProvider();
    expect(
      await runOffboardingJob(deps(sms, undefined), { tenantId, action: "cancellation-notices" }),
    ).toEqual({
      sms: "sent",
      email: "not-configured",
    });
    expect(sms.sent[0]!.body).toContain("ask your network to turn your voicemail back on");
  });
});
