// The post-call pipeline end to end, with the fakes: process-call, then every job it queues,
// each delivered twice (pg-boss redelivers after a crash or a timeout). Whatever the LLM says
// and however often a job runs, the tradesperson gets each message exactly once, emergencies
// first, and caller text never reaches the HTML unescaped.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EMPTY_TRANSCRIPT_SUMMARY, EXTRACTION_FAILED_SUMMARY } from "../core/extraction.ts";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import { DANGER_SCRIPT, GAS_EMERGENCY_NUMBER, gasScript } from "../core/scripts.ts";
import { verifyCallLink } from "../core/signed-links.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeEmailProvider } from "../providers/email.fake.ts";
import { FakeLlmProvider } from "../providers/llm.fake.ts";
import { FakeSmsProvider } from "../providers/sms.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import type { NotifiableCall } from "./enqueue-notifications.ts";
import { runNotifyEmail } from "./notify-email.ts";
import { runNotifyEmergency } from "./notify-emergency.ts";
import { runNotifySms } from "./notify-sms.ts";
import { runProcessCall } from "./process-call.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const MOBILE = "+447700900001";
const CALLER = "+447700900123";
const EMAIL = "owner@example.com";
const SECRET = "pipeline-test-signing-secret-32-characters";
const BASE_URL = "https://callmate.example.com";
const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';

async function makeCall(transcript: string, callerNumber: string | null = CALLER) {
  const tenantId = await createTenant(admin, {
    businessName: "Pipeline Plumbing",
    contactName: "Ant",
    trade: "plumber",
    notificationMobile: MOBILE,
    notificationEmail: EMAIL,
  });
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at, transcript)
     VALUES ($1, $2, $3, now() - interval '2 minutes', now(), $4) RETURNING id`,
    [tenantId, `call_${randomUUID()}`, callerNumber, transcript],
  );
  return { tenantId, callId: rows[0]!.id };
}

const extraction = (overrides: Record<string, unknown> = {}) => ({
  callerName: "Sam",
  callbackNumber: CALLER,
  postcode: "XQ12 3JL",
  jobSummary: "Boiler leaking.",
  urgency: "routine",
  priceAsked: false,
  flags: [],
  ...overrides,
});

/** Runs process-call, then every job it queued, each `deliveries` times, in queue order. */
async function runPipeline(
  { tenantId, callId }: { tenantId: string; callId: string },
  llm: FakeLlmProvider,
  deliveries = 2,
) {
  const sms = new FakeSmsProvider();
  const email = new FakeEmailProvider();
  const alert = vi.fn();
  const outbound = {
    nodeEnv: "test" as const,
    allowlist: parseAllowlist(`${MOBILE},${CALLER},${EMAIL}`),
  };
  const queued: NotifiableCall[] = [];
  const outcome = await runProcessCall(
    {
      pool: app,
      llm,
      alert,
      enqueueNotifications: (_client, call) => {
        queued.push(call);
        return Promise.resolve();
      },
    },
    { tenantId, callId, providerCallId: "unused" },
  );
  for (let round = 0; round < deliveries; round++) {
    for (const job of queued) {
      if (job.urgency === "emergency") {
        await runNotifyEmergency(
          { pool: app, sms, outbound, alert },
          { tenantId, callId, ...(job.emergencyKind && { kind: job.emergencyKind }) },
        );
      }
      if (job.emergencyOnly) continue;
      const notify = { pool: app, outbound, signingSecret: SECRET, publicBaseUrl: BASE_URL, alert };
      await runNotifySms({ ...notify, sms }, { tenantId, callId });
      await runNotifyEmail({ ...notify, email }, { tenantId, callId });
    }
  }
  const notifications = await withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query<{ channel: string; status: string }>(
          "SELECT channel, status FROM notifications WHERE call_id = $1 ORDER BY channel",
          [callId],
        )
      ).rows,
  );
  return { outcome, sms, email, alert, queued, notifications };
}

describe("the post-call pipeline, delivered twice", () => {
  it("sends a gas emergency's three texts and one email exactly once, the emergency first", async () => {
    const call = await makeCall(
      [
        "agent: Hi, you're through to Pipeline Plumbing. How can I help?",
        "caller: I can smell gas in the kitchen.",
        `agent: ${gasScript("Ant", "GB")}`,
      ].join("\n"),
    );
    // The LLM misjudges it: the spoken script still makes it an emergency.
    const { outcome, sms, email, notifications } = await runPipeline(
      call,
      new FakeLlmProvider().willReturn(extraction({ urgency: "routine" })),
    );
    expect(outcome).toBe("extracted");
    expect(sms.sent.map((text) => text.to)).toEqual([MOBILE, CALLER, MOBILE]);
    const [priority, toCaller, summary] = sms.sent;
    expect(priority!.body.startsWith("EMERGENCY: a caller just reported an emergency")).toBe(true);
    expect(toCaller!.body).toContain(`on ${GAS_EMERGENCY_NUMBER.GB}.`);
    expect(summary!.body.split("\n")[0]).toBe("EMERGENCY: Sam, 07700 900123, XQ12 3JL");
    expect(email.sent).toHaveLength(1);
    expect(notifications).toEqual([
      { channel: "email", status: "sent" },
      { channel: "sms", status: "sent" },
      { channel: "sms_caller", status: "sent" },
      { channel: "sms_emergency", status: "sent" },
    ]);
  });

  it("texts only the tradesperson (never the caller) for the danger script", async () => {
    const call = await makeCall(`caller: There's smoke.\nagent: ${DANGER_SCRIPT}`);
    const { sms } = await runPipeline(
      call,
      new FakeLlmProvider().willReturn(extraction({ urgency: "emergency" })),
    );
    expect(sms.sent.map((text) => text.to)).toEqual([MOBILE, MOBILE]);
  });

  it("still sends everything once when the LLM is refused for good, saying to read the transcript", async () => {
    const call = await makeCall(`caller: Hello?\nagent: ${DANGER_SCRIPT}`);
    const { outcome, sms, email, alert } = await runPipeline(
      call,
      new FakeLlmProvider().willThrow("invalid x-api-key", 401),
    );
    expect(outcome).toBe("extraction-failed");
    expect(sms.sent).toHaveLength(2);
    expect(sms.sent[1]!.body).toContain(EXTRACTION_FAILED_SUMMARY);
    expect(sms.sent[1]!.body.split("\n")[0]).toBe("EMERGENCY: 07700 900123");
    expect(email.sent).toHaveLength(1);
    expect(alert).toHaveBeenCalledWith("call-extraction-failed", expect.anything());
  });

  // These used to get nothing at all: the tradesperson never heard someone had rung.
  it("tells the tradesperson about a call with an empty transcript, once, without the LLM", async () => {
    const call = await makeCall("");
    const llm = new FakeLlmProvider();
    const { outcome, sms, email, notifications } = await runPipeline(call, llm);
    expect(outcome).toBe("empty-transcript");
    expect(llm.requests).toHaveLength(0);
    expect(sms.sent.map((text) => text.to)).toEqual([MOBILE]);
    expect(sms.sent[0]!.body.split("\n").slice(0, 3)).toEqual([
      "Call: 07700 900123",
      EMPTY_TRANSCRIPT_SUMMARY,
      `Call back: tel:${CALLER}`,
    ]);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.subject).toBe(
      `Call: Unknown caller, 07700 900123 - ${EMPTY_TRANSCRIPT_SUMMARY}`,
    );
    expect(email.sent[0]!.text).toContain("Transcript\n(none)");
    expect(notifications).toEqual([
      { channel: "email", status: "sent" },
      { channel: "sms", status: "sent" },
    ]);
  });

  it("says 'number withheld' for an empty transcript from a withheld number", async () => {
    const { sms } = await runPipeline(await makeCall("", null), new FakeLlmProvider());
    expect(sms.sent[0]!.body.split("\n")[0]).toBe("Call: number withheld");
    expect(sms.sent[0]!.body).not.toContain("tel:");
  });

  it("escapes whatever the LLM wrote in the email, and the text stays GSM-7 with a working link", async () => {
    const call = await makeCall(`agent: Hello.\ncaller: ${HOSTILE}`);
    const { sms, email } = await runPipeline(
      call,
      new FakeLlmProvider().willReturn(
        extraction({
          callerName: HOSTILE,
          postcode: HOSTILE,
          jobSummary: HOSTILE,
          flags: [HOSTILE],
        }),
      ),
    );
    const [message] = email.sent;
    expect(message!.html).not.toMatch(/<script|<img/i);
    expect(message!.html).toContain("&lt;script&gt;");
    const link = /Details: (\S+)$/m.exec(sms.sent[0]!.body)?.[1];
    expect(link?.startsWith(`${BASE_URL}/c/`)).toBe(true);
    expect(verifyCallLink(link!.split("/c/")[1]!, SECRET)).toEqual({
      ok: true,
      callId: call.callId,
    });
  });

  it("reads a call-back number written '0044 (0)...', and shows the caller ID too", async () => {
    const call = await makeCall("agent: Hello.\ncaller: Ring me on my other phone.");
    const { sms, email } = await runPipeline(
      call,
      new FakeLlmProvider().willReturn(extraction({ callbackNumber: "0044 (0)7700 900456" })),
    );
    expect(sms.sent[0]!.body).toContain("Call back: tel:+447700900456");
    expect(email.sent[0]!.text).toContain("Rang from: 07700 900123 (tel:+447700900123)");
  });

  it("falls back to the caller ID when the LLM's number isn't one", async () => {
    const call = await makeCall("agent: Hello.\ncaller: Call me back.");
    const { sms } = await runPipeline(
      call,
      new FakeLlmProvider().willReturn(extraction({ callbackNumber: "the usual one" })),
    );
    expect(sms.sent[0]!.body).toContain(`Call back: tel:${CALLER}`);
  });

  it("says 'number withheld' and gives no tel: link when there's no number at all", async () => {
    const call = await makeCall("agent: Hello.\ncaller: Hi.", null);
    const { sms } = await runPipeline(
      call,
      new FakeLlmProvider().willReturn(extraction({ callbackNumber: null })),
    );
    expect(sms.sent[0]!.body.split("\n")[0]).toBe("New enquiry: Sam, number withheld, XQ12 3JL");
    expect(sms.sent[0]!.body).not.toContain("tel:");
  });

  it("does the work once when process-call itself is redelivered after finishing", async () => {
    const call = await makeCall(`agent: ${DANGER_SCRIPT}`);
    const llm = new FakeLlmProvider().willReturn(extraction({ urgency: "emergency" }));
    const costs = () =>
      withTenant(app, call.tenantId, async (client) =>
        (
          await client.query<{ component: string }>(
            "SELECT component FROM call_costs WHERE call_id = $1 ORDER BY component",
            [call.callId],
          )
        ).rows.map((row) => row.component),
      );
    await runPipeline(call, llm);
    const afterFirst = await costs();
    // One row per token kind, and one per text sent (the priority text and the summary).
    expect(afterFirst).toEqual([
      `${llm.model}:input_tokens`,
      `${llm.model}:output_tokens`,
      "sms:segments",
      "sms:segments",
    ]);
    const again = await runPipeline(call, new FakeLlmProvider());
    expect(again.outcome).toBe("already-processed");
    expect(again.queued).toEqual([]);
    expect(again.sms.sent).toEqual([]);
    // The redelivery added nothing: no tokens, no texts, so no cost.
    expect(await costs()).toEqual(afterFirst);
  });
});
