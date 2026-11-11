import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import {
  addMembership,
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  createUser,
} from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeAuthProvider } from "../providers/auth.fake.ts";
import { FakeEmailProvider } from "../providers/email.fake.ts";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import { FakeSmsProvider } from "../providers/sms.fake.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { sampleAgentDefinition } from "../testing/agent-fixture.ts";
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
  it("sends nothing once the cancellation has been undone", async () => {
    const tenantId = await leavingBusiness("vodafone");
    await admin.query(
      "UPDATE tenants SET status = 'live', cancellation_requested_at = NULL WHERE id = $1",
      [tenantId],
    );
    const sms = new FakeSmsProvider();
    const email = new FakeEmailProvider();
    expect(
      await runOffboardingJob(deps(sms, email), { tenantId, action: "cancellation-notices" }),
    ).toEqual({ sms: "not-leaving", email: "not-leaving" });
    expect(sms.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
  });

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

  it("still emails when the text fails, then retries only the text", async () => {
    const tenantId = await leavingBusiness("ee");
    const sms = new FakeSmsProvider().willFail("Twilio refused the number");
    const email = new FakeEmailProvider();
    await expect(
      runOffboardingJob(deps(sms, email), { tenantId, action: "cancellation-notices" }),
    ).rejects.toThrow(/Cancellation sms failed/);
    expect(email.sent).toHaveLength(1);

    // The queue's retry.
    expect(
      await runOffboardingJob(deps(sms, email), { tenantId, action: "cancellation-notices" }),
    ).toEqual({ sms: "sent", email: "already-sent" });
    expect(sms.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
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

describe("the delete-data action", () => {
  /** A business that has cancelled and had its number released, with data everywhere. */
  async function goneBusiness() {
    const tenantId = await createTenant(admin, {
      businessName: "Gone Plumbing",
      trade: "plumber",
      contactName: "Sam",
      notificationMobile: MOBILE,
      notificationEmail: EMAIL,
    });
    const subject = `sub_${randomUUID()}`;
    const owner = await createUser(admin, {
      authSubject: subject,
      email: `gone-${randomUUID()}@example.com`,
      role: "owner",
    });
    await addMembership(admin, tenantId, owner);
    // Someone who also runs another business keeps their login and their account.
    const sharedSubject = `sub_${randomUUID()}`;
    const shared = await createUser(admin, {
      authSubject: sharedSubject,
      email: `shared-${randomUUID()}@example.com`,
      role: "owner",
    });
    await addMembership(admin, tenantId, shared);
    const other = await createTenant(admin, {
      businessName: "Still Here Sparks",
      trade: "electrician",
    });
    await addMembership(admin, other, shared);
    await admin.query(
      "INSERT INTO terms_acceptances (tenant_id, document_type, document_version, accepted_by) VALUES ($1, 'terms', 'v1', $2)",
      [tenantId, owner],
    );
    await admin.query(
      "INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds) VALUES ($1, '2026-10-01', '2026-11-01', 300)",
      [tenantId],
    );
    const agentId = `agent_${randomUUID()}`;
    await admin.query(
      "INSERT INTO agent_profiles (tenant_id, version, trade_template, provider_agent_id) VALUES ($1, 1, 'plumber', $2)",
      [tenantId, agentId],
    );
    const agentCall = `call_${randomUUID()}`;
    const voicemailCall = `CA${randomUUID().replaceAll("-", "")}`;
    const recording = `RE${randomUUID().replaceAll("-", "")}`;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, started_at, summary, transcript)
       VALUES ($1, $2, now(), 'Boiler leaking.', 'caller: help') RETURNING id`,
      [tenantId, agentCall],
    );
    await admin.query(
      `INSERT INTO calls (tenant_id, provider_call_id, started_at, via_fallback, recording_ref)
       VALUES ($1, $2, now(), true, $3)`,
      [
        tenantId,
        voicemailCall,
        `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/${recording}`,
      ],
    );
    await admin.query(
      "INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated) VALUES ($1, $2, 'sms:segments', 1, 'segments', false)",
      [tenantId, rows[0]!.id],
    );
    // The texts sent about it, which Twilio holds by their SIDs, and emails, which it doesn't.
    const sid = () => `SM${randomUUID().replaceAll("-", "")}`;
    const texts = [sid(), sid(), sid(), sid()];
    await withTenant(app, tenantId, async (client) => {
      await client.query(
        `INSERT INTO notifications (tenant_id, call_id, channel, status, attempts, provider_ref)
         VALUES ($1, $2, 'sms', 'sent', 1, $3), ($1, $2, 'sms_caller', 'sent', 1, $4),
                ($1, $2, 'email', 'sent', 1, $5)`,
        [tenantId, rows[0]!.id, texts[0], texts[1], `email_${randomUUID()}`],
      );
      await client.query(
        "INSERT INTO onboarding_texts (tenant_id, kind, status, provider_ref) VALUES ($1, 'divert_instructions', 'sent', $2)",
        [tenantId, texts[2]],
      );
      // A caller the business blocked: their number is personal data, so it goes too.
      await client.query(
        "INSERT INTO blocked_numbers (tenant_id, number, reason) VALUES ($1, '+447700900642', 'nuisance')",
        [tenantId],
      );
      await client.query(
        `INSERT INTO offboarding_messages (tenant_id, kind, channel, status, provider_ref)
         VALUES ($1, 'cancellation', 'sms', 'sent', $2), ($1, 'cancellation', 'email', 'sent', $3)`,
        [tenantId, texts[3], `email_${randomUUID()}`],
      );
    });
    const number = `+441632960${String(Math.floor(Math.random() * 990)).padStart(3, "0")}`;
    await admin.query(
      "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
      [number],
    );
    await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
    // Held from 1 October until it was released on 3 November.
    await admin.query(
      "UPDATE phone_numbers SET created_at = '2026-10-01T09:00:00Z', status = 'released', released_at = '2026-11-03T12:00:00Z' WHERE tenant_id = $1",
      [tenantId],
    );
    await admin.query(
      "UPDATE tenants SET status = 'cancelled', cancellation_requested_at = now() - interval '31 days' WHERE id = $1",
      [tenantId],
    );
    return {
      tenantId,
      owner,
      subject,
      shared,
      sharedSubject,
      agentId,
      agentCall,
      recording,
      number,
      texts,
    };
  }

  function deletionDeps(email: FakeEmailProvider, allowlist = `${MOBILE},${EMAIL}`) {
    const voice = new FakeVoiceProvider();
    const telephony = new FakeTelephonyProvider();
    const auth = new FakeAuthProvider();
    const sms = new FakeSmsProvider();
    const alerts: string[] = [];
    const jobDeps: OffboardingJobDeps = {
      ...deps(sms, email, allowlist),
      deletion: { admin, voice, telephony, auth },
      alert: (alert) => {
        alerts.push(alert);
      },
    };
    return { voice, telephony, auth, sms, alerts, jobDeps };
  }

  const count = async (table: string, tenantId: string) =>
    Number(
      (
        await admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`,
          [tenantId],
        )
      ).rows[0]!.n,
    );

  /** Makes the gone business one that paid: live from 14 August, left on 11 October. */
  async function paidBusiness(lastStatus: string) {
    const gone = await goneBusiness();
    await admin.query(
      `UPDATE tenants SET billing_start_date = '2026-08-14',
              cancellation_requested_at = '2026-10-11T10:00:00Z' WHERE id = $1`,
      [gone.tenantId],
    );
    const mandateRef = `MD${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await withTenant(app, gone.tenantId, async (client) => {
      await client.query(
        `INSERT INTO payment_mandates (tenant_id, setup_ref, authorisation_url, expires_at, mandate_ref, status, activated_at)
         VALUES ($1, $2, 'https://pay.fake.invalid', now(), $3, 'active', now())`,
        [gone.tenantId, `BRQ${randomUUID()}`, mandateRef],
      );
      // Charged for the months starting 14 August and 14 September (it left in the second).
      await client.query(
        `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
           billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
           vat_pence, total_pence, lines, status)
         VALUES ($1, '2026-08-14', '2026-09-14', 0, 0, 9900, 0, 0, 0, 0, 9900, '[]', 'paid_out'),
                ($1, '2026-09-14', '2026-10-14', 1, 0, 9900, 0, 0, 0, 0, 9900, '[]', $2)`,
        [gone.tenantId, lastStatus],
      );
    });
    return { ...gone, mandateRef };
  }

  it("cancels the Direct Debit with everything else once all it owes is collected", async () => {
    const gone = await paidBusiness("confirmed");
    const payments = new FakePaymentsProvider();
    const { jobDeps } = deletionDeps(new FakeEmailProvider());
    const run = {
      ...jobDeps,
      deletion: { ...jobDeps.deletion!, payments },
      now: () => new Date("2026-11-11T12:00:00Z"),
    };
    expect(
      await runOffboardingJob(run, { tenantId: gone.tenantId, action: "delete-data" }),
    ).toMatchObject({ outcome: "deleted" });
    expect(payments.cancelledMandates).toEqual([gone.mandateRef]);
    const { rows } = await admin.query(
      "SELECT status, end_reason FROM payment_mandates WHERE tenant_id = $1",
      [gone.tenantId],
    );
    expect(rows).toEqual([{ status: "cancelled", end_reason: "business_left" }]);
    // The billing record stays: it holds no personal data.
    expect(await count("billing_charges", gone.tenantId)).toBe(2);
  });

  it("waits, touching nothing, while its last payment is still being collected", async () => {
    const gone = await paidBusiness("submitted");
    const payments = new FakePaymentsProvider();
    const { voice, jobDeps } = deletionDeps(new FakeEmailProvider());
    const run = {
      ...jobDeps,
      deletion: { ...jobDeps.deletion!, payments },
      now: () => new Date("2026-11-11T12:00:00Z"),
    };
    expect(
      await runOffboardingJob(run, { tenantId: gone.tenantId, action: "delete-data" }),
    ).toEqual({ outcome: "billing-outstanding" });
    expect(payments.cancelledMandates).toEqual([]);
    expect(voice.deleteCalls).toEqual([]);
    expect(await count("calls", gone.tenantId)).toBe(2);
  });

  it("deletes at the providers, confirms in writing once, then deletes here, keeping the billing record", async () => {
    const gone = await goneBusiness();
    const email = new FakeEmailProvider();
    const { voice, telephony, auth, sms, alerts, jobDeps } = deletionDeps(email);
    voice.agents.set(gone.agentId, sampleAgentDefinition());
    // Twilio's call records for the number: the incoming call and the leg it spawned to Retell,
    // and a call after the number was released, which belongs to whoever holds it next.
    telephony.callRecords.set("CAincoming", {
      to: gone.number,
      startedAt: new Date("2026-10-20T10:00:00Z"),
      parentCallSid: null,
    });
    telephony.callRecords.set("CAtoRetell", {
      to: "sip:agent@sip.example.com",
      startedAt: new Date("2026-10-20T10:00:01Z"),
      parentCallSid: "CAincoming",
    });
    telephony.callRecords.set("CAnextHolder", {
      to: gone.number,
      startedAt: new Date("2026-11-05T10:00:00Z"),
      parentCallSid: null,
    });

    expect(
      await runOffboardingJob(jobDeps, {
        tenantId: gone.tenantId,
        action: "delete-data",
        actorUserId: gone.owner,
      }),
    ).toEqual({ outcome: "deleted", confirmation: "email", calls: 2 });

    // At the providers.
    expect(voice.deleteCalls).toContain(gone.agentCall);
    expect(voice.deletedAgents).toEqual([gone.agentId]);
    expect(voice.agents.has(gone.agentId)).toBe(false);
    expect(telephony.deletedRecordings).toEqual([gone.recording]);
    expect(telephony.deletedCalls).toEqual(["CAtoRetell", "CAincoming"]);
    expect(telephony.callRecords.has("CAnextHolder")).toBe(true);
    expect([...sms.deletedMessages].sort()).toEqual([...gone.texts].sort());
    expect(auth.deletedLogins).toEqual([gone.subject]);
    // In writing.
    expect(email.sent.map((sent) => [sent.to, sent.subject])).toEqual([
      [EMAIL, "Your AnswerMate data has been deleted"],
    ]);
    // Here: the data has gone, the business is anonymous, the billing and legal records stay.
    for (const table of [
      "calls",
      "call_costs",
      "notifications",
      "agent_profiles",
      "blocked_numbers",
      "onboarding_texts",
      "tenant_memberships",
      "offboarding_messages",
    ]) {
      expect(await count(table, gone.tenantId), table).toBe(0);
    }
    expect(await count("usage_periods", gone.tenantId)).toBe(1);
    expect(await count("terms_acceptances", gone.tenantId)).toBe(1);
    const tenant = (
      await admin.query(
        "SELECT business_name, contact_name, notification_mobile, notification_email, data_deleted_at FROM tenants WHERE id = $1",
        [gone.tenantId],
      )
    ).rows[0] as Record<string, unknown>;
    expect(tenant).toMatchObject({
      business_name: "Deleted business",
      contact_name: null,
      notification_mobile: null,
      notification_email: null,
    });
    expect(tenant.data_deleted_at).toBeInstanceOf(Date);
    const person = (
      await admin.query<{ email: string; auth_subject: string | null }>(
        "SELECT email, auth_subject FROM users WHERE id = $1",
        [gone.owner],
      )
    ).rows[0]!;
    expect(person).toEqual({ email: `deleted-${gone.owner}@deleted.invalid`, auth_subject: null });
    const sharedPerson = (
      await admin.query<{ auth_subject: string | null }>(
        "SELECT auth_subject FROM users WHERE id = $1",
        [gone.shared],
      )
    ).rows[0]!;
    expect(sharedPerson.auth_subject).toBe(gone.sharedSubject);
    const actions = (
      await admin.query<{ action: string }>("SELECT action FROM audit_log WHERE tenant_id = $1", [
        gone.tenantId,
      ])
    ).rows.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(["tenant.deletion-confirmed", "tenant.data-deleted"]),
    );

    // Running again changes nothing and sends nothing.
    expect(
      await runOffboardingJob(jobDeps, { tenantId: gone.tenantId, action: "delete-data" }),
    ).toEqual({
      outcome: "already-deleted",
    });
    expect(email.sent).toHaveLength(1);
    expect(alerts).toEqual([]);
  });

  it("deletes nothing for a business that hasn't finished cancelling", async () => {
    const gone = await goneBusiness();
    await admin.query("UPDATE tenants SET status = 'cancelling' WHERE id = $1", [gone.tenantId]);
    const { voice, telephony, jobDeps } = deletionDeps(new FakeEmailProvider());
    expect(
      await runOffboardingJob(jobDeps, { tenantId: gone.tenantId, action: "delete-data" }),
    ).toEqual({
      outcome: "not-cancelled",
    });
    expect(voice.deleteCalls).toHaveLength(0);
    expect(telephony.deletedCalls).toHaveLength(0);
    expect(await count("calls", gone.tenantId)).toBe(2);
  });

  it("raises an alert when the written confirmation can't go at all, and still deletes", async () => {
    const gone = await goneBusiness();
    const email = new FakeEmailProvider();
    const { jobDeps, sms, alerts } = deletionDeps(email, "+447700900998");
    expect(
      await runOffboardingJob(jobDeps, { tenantId: gone.tenantId, action: "delete-data" }),
    ).toMatchObject({
      outcome: "deleted",
      confirmation: "not-sent",
    });
    expect(email.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);
    expect(alerts).toEqual(["deletion-confirmation-not-sent"]);
    expect(await count("calls", gone.tenantId)).toBe(0);
    const failed = await admin.query(
      "SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.deletion-confirmation-failed'",
      [gone.tenantId],
    );
    expect(failed.rowCount).toBe(1);
  });

  it("confirms by text when the email can't go, as after a bounce", async () => {
    const gone = await goneBusiness();
    const email = new FakeEmailProvider().willFail("Postmark refused an inactive recipient");
    const { sms, alerts, jobDeps } = deletionDeps(email);
    expect(
      await runOffboardingJob(jobDeps, { tenantId: gone.tenantId, action: "delete-data" }),
    ).toMatchObject({ outcome: "deleted", confirmation: "sms" });
    expect(sms.sent.map((sent) => sent.to)).toEqual([MOBILE]);
    expect(sms.sent[0]!.body).toContain("written confirmation");
    expect(alerts).toEqual([]);
    const confirmed = await admin.query<{ details: unknown }>(
      "SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.deletion-confirmed'",
      [gone.tenantId],
    );
    expect(confirmed.rows[0]!.details).toMatchObject({ sentBy: "sms" });
  });

  it("won't run twice at once for one business", async () => {
    const gone = await goneBusiness();
    const { jobDeps } = deletionDeps(new FakeEmailProvider());
    const holder = await admin.connect();
    try {
      // Another run of the same job, still going.
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [`delete-data:${gone.tenantId}`]);
      await expect(
        runOffboardingJob(jobDeps, { tenantId: gone.tenantId, action: "delete-data" }),
      ).rejects.toThrow(/already running/);
      expect(await count("calls", gone.tenantId)).toBe(2);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  });

  it("deletes nothing when a login must go and the login provider isn't set up", async () => {
    const gone = await goneBusiness();
    const { voice, jobDeps } = deletionDeps(new FakeEmailProvider());
    const withoutAuth: OffboardingJobDeps = {
      ...jobDeps,
      deletion: { ...jobDeps.deletion!, auth: undefined },
    };
    await expect(
      runOffboardingJob(withoutAuth, { tenantId: gone.tenantId, action: "delete-data" }),
    ).rejects.toThrow(/CLERK_SECRET_KEY/);
    expect(voice.deleteCalls).toHaveLength(0);
    expect(await count("calls", gone.tenantId)).toBe(2);
  });
});
