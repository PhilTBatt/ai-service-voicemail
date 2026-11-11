import { afterEach, describe, expect, it, vi } from "vitest";
import { alertEmailer, alertMessage } from "./alert-email.ts";
import { raiseAlert, setAlertSink } from "./alerts.ts";
import { logger } from "./logger.ts";
import { FakeEmailProvider } from "./providers/email.fake.ts";

const TO = "phil@example.com";
const outbound = { nodeEnv: "test" as const, allowlist: new Set([TO]) };
const start = new Date("2026-11-10T14:03:00Z");

function emailer(overrides: Partial<Parameters<typeof alertEmailer>[0]> = {}) {
  const email = new FakeEmailProvider();
  let now = start;
  const sink = alertEmailer({ email, to: TO, outbound, now: () => now, ...overrides });
  return { email, sink, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

afterEach(() => {
  setAlertSink(undefined);
  vi.restoreAllMocks();
});

describe("alertEmailer", () => {
  it("emails the alert, with its details redacted and the UK time", async () => {
    const { email, sink } = emailer();
    await sink("agent-sync-failed", {
      tenantId: "t1",
      note: "caller on +447700900123",
      error: new Error("Retell said no"),
    });
    expect(email.sent).toHaveLength(1);
    const [sent] = email.sent;
    expect(sent?.to).toBe(TO);
    expect(sent?.subject).toBe("[AnswerMate] agent-sync-failed");
    expect(sent?.text).toContain("At: 10 Nov 2026, 14:03 (UK time)");
    expect(sent?.text).toContain('"tenantId": "t1"');
    expect(sent?.text).toContain("[phone]");
    expect(sent?.text).not.toContain("+447700900123");
    expect(sent?.text).toContain("Error: Retell said no");
    expect(sent?.text).toContain("RUNBOOK.md, section 11");
    expect(sent?.html).toContain("<pre");
  });

  it("sends one email per alert per 15 minutes, counting the rest into the next", async () => {
    const { email, sink, advance } = emailer();
    await sink("sms-undelivered", { a: 1 });
    await sink("sms-undelivered", { a: 2 });
    await sink("sms-undelivered", { a: 3 });
    await sink("email-bounced", {}); // a different alert isn't held back
    expect(email.sent.map((sent) => sent.subject)).toEqual([
      "[AnswerMate] sms-undelivered",
      "[AnswerMate] email-bounced",
    ]);

    advance(15 * 60_000);
    await sink("sms-undelivered", { a: 4 });
    expect(email.sent).toHaveLength(3);
    expect(email.sent[2]?.subject).toBe("[AnswerMate] sms-undelivered (+2)");
    expect(email.sent[2]?.text).toContain("Plus 2 more of these since the last email about it.");
  });

  it("emails each business's billing and delivery alerts, while outages stay one email", async () => {
    const { email, sink } = emailer();
    // The 06:00 run finds two businesses without a Direct Debit: both need doing.
    await sink("billing-no-mandate", { tenantId: "t1" });
    await sink("billing-no-mandate", { tenantId: "t2" });
    await sink("billing-no-mandate", { tenantId: "t1" }); // the same business again: held
    // An outage hitting two businesses is one problem, one email.
    await sink("voice-platform-unreachable", { tenantId: "t1" });
    await sink("voice-platform-unreachable", { tenantId: "t2" });
    expect(email.sent.map((sent) => sent.subject)).toEqual([
      "[AnswerMate] billing-no-mandate",
      "[AnswerMate] billing-no-mandate",
      "[AnswerMate] voice-platform-unreachable",
    ]);
    expect(email.sent[1]?.text).toContain('"tenantId": "t2"');
  });

  it("never emails an address outside the allowlist outside production", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const { email, sink } = emailer({ to: "someone-else@example.com" });
    await sink("guardrail-hit", {});
    expect(email.sent).toHaveLength(0);
    // Said in the log, so a missing alert email can be traced to the allowlist.
    expect(warn).toHaveBeenCalledWith(
      "Alert email not sent",
      expect.objectContaining({ alert: "guardrail-hit" }),
    );
  });

  it("logs a failed send and carries on", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const { email, sink } = emailer();
    email.willFail("Postmark is down");
    await expect(sink("job-dead-lettered", {})).resolves.toBeUndefined();
    expect(email.sent).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      "Alert email failed",
      expect.objectContaining({ alert: "job-dead-lettered" }),
    );
  });

  it("is what raiseAlert hands every alert to, without waiting on it", async () => {
    const { email, sink } = emailer();
    const spy = vi.fn(sink);
    setAlertSink(spy);
    raiseAlert("call-extraction-failed", { callId: "c1" });
    expect(spy).toHaveBeenCalledWith("call-extraction-failed", { callId: "c1" });
    await vi.waitFor(() => expect(email.sent).toHaveLength(1));
  });
});

describe("alertMessage", () => {
  it("escapes the details for the HTML version", () => {
    const message = alertMessage({
      alert: "guardrail-hit",
      details: { rule: "<no prices>" },
      at: start,
      suppressed: 0,
      to: TO,
    });
    expect(message.text).toContain("<no prices>");
    expect(message.html).toContain("&lt;no prices&gt;");
    expect(message.html).not.toContain("<no prices>");
  });
});
