// The alert email's edges: the throttle's exact boundary, which alerts count per business, what
// a failed or refused send does to the count, the UK time across the clock changes, and the
// redaction of everything a detail can carry.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_EMAIL_RETRY_FIRST_MS,
  alertEmailer,
  alertMessage,
  installAlertEmail,
} from "./alert-email.ts";
import { ALERTS, raiseAlert, setAlertSink } from "./alerts.ts";
import type { OutboundPolicy } from "./core/outbound-allowlist.ts";
import { logger } from "./logger.ts";
import type { EmailProvider } from "./providers/email.ts";
import { FakeEmailProvider } from "./providers/email.fake.ts";

const TO = "alerts@example.com";
const testPolicy: OutboundPolicy = { nodeEnv: "test", allowlist: new Set([TO]) };
const start = new Date("2026-11-10T14:00:00Z");
const MINUTE = 60_000;

function emailer(options: { to?: string; outbound?: OutboundPolicy; minIntervalMs?: number } = {}) {
  const email = new FakeEmailProvider();
  let now = start;
  const sink = alertEmailer({
    email,
    to: options.to ?? TO,
    outbound: options.outbound ?? testPolicy,
    now: () => now,
    ...(options.minIntervalMs !== undefined && { minIntervalMs: options.minIntervalMs }),
  });
  return {
    email,
    sink,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    subjects: () => email.sent.map((sent) => sent.subject),
  };
}

afterEach(() => {
  setAlertSink(undefined);
  vi.restoreAllMocks();
});

describe("the throttle", () => {
  it("holds the same alert for 15 minutes less a millisecond, and sends it at exactly 15", async () => {
    const { sink, advance, subjects } = emailer();
    await sink("guardrail-hit", {});
    advance(15 * MINUTE - 1);
    await sink("guardrail-hit", {});
    expect(subjects()).toEqual(["[AnswerMate] guardrail-hit"]);
    advance(1);
    await sink("guardrail-hit", {});
    expect(subjects()).toEqual(["[AnswerMate] guardrail-hit", "[AnswerMate] guardrail-hit (+1)"]);
  });

  it("starts the count again after each email, so the next says only what it stood in for", async () => {
    const { sink, advance, subjects } = emailer();
    await sink("sms-undelivered", {});
    await sink("sms-undelivered", {});
    await sink("sms-undelivered", {});
    advance(15 * MINUTE);
    await sink("sms-undelivered", {}); // "+2"
    advance(15 * MINUTE);
    await sink("sms-undelivered", {}); // nothing held since: no count
    expect(subjects()).toEqual([
      "[AnswerMate] sms-undelivered",
      "[AnswerMate] sms-undelivered (+2)",
      "[AnswerMate] sms-undelivered",
    ]);
  });

  it("measures the window from the last email sent, not from the last alert held", async () => {
    const { sink, advance, subjects } = emailer();
    await sink("webhook-signature-spike", {});
    // Held alerts every five minutes never push the next email back.
    for (let i = 0; i < 3; i += 1) {
      advance(5 * MINUTE);
      await sink("webhook-signature-spike", {});
    }
    expect(subjects()).toHaveLength(2);
    expect(subjects()[1]).toBe("[AnswerMate] webhook-signature-spike (+2)");
  });

  it("sends one email when the same alert comes twice at once, counting the other", async () => {
    // The window now starts once the email has gone, so the second mustn't slip in meanwhile.
    const { sink, advance, subjects } = emailer();
    await Promise.all([sink("guardrail-hit", {}), sink("guardrail-hit", {})]);
    expect(subjects()).toEqual(["[AnswerMate] guardrail-hit"]);
    advance(15 * MINUTE);
    await sink("guardrail-hit", {});
    expect(subjects()).toEqual(["[AnswerMate] guardrail-hit", "[AnswerMate] guardrail-hit (+1)"]);
  });

  it("takes its own interval when given one", async () => {
    const { sink, advance, subjects } = emailer({ minIntervalMs: MINUTE });
    await sink("guardrail-hit", {});
    advance(MINUTE);
    await sink("guardrail-hit", {});
    expect(subjects()).toHaveLength(2);
  });

  it("keeps every alert's window apart: each different alert is its own email", async () => {
    const { sink, subjects } = emailer();
    for (const alert of ALERTS) await sink(alert, {});
    expect(subjects()).toEqual(ALERTS.map((alert) => `[AnswerMate] ${alert}`));
  });

  it("keeps two emailers' windows apart (each process has its own)", async () => {
    const first = emailer();
    const second = emailer();
    await first.sink("guardrail-hit", {});
    await second.sink("guardrail-hit", {});
    expect(first.subjects()).toHaveLength(1);
    expect(second.subjects()).toHaveLength(1);
  });
});

describe("per-business alerts", () => {
  it.each([
    "notification-no-mobile",
    "notification-no-email",
    "notification-refused",
    "recipient-opted-out",
    "email-bounced",
    "email-spam-complaint",
    "number-bought-not-recorded",
    "deletion-confirmation-not-sent",
    "payment-mandate-ended",
    "billing-no-mandate",
    "billing-payment-failed",
  ] as const)("%s: one email per business in the window", async (alert) => {
    const { sink, subjects } = emailer();
    await sink(alert, { tenantId: "t1" });
    await sink(alert, { tenantId: "t2" });
    await sink(alert, { tenantId: "t1" });
    expect(subjects()).toEqual([`[AnswerMate] ${alert}`, `[AnswerMate] ${alert}`]);
  });

  it.each([
    "job-dead-lettered",
    "voice-platform-unreachable",
    "agent-sync-failed",
    "call-extraction-failed",
    "sms-undelivered",
    "fallback-voicemail-spike",
    "server-error-spike",
    "scheduled-job-overdue",
  ] as const)("%s: one email however many businesses it touches", async (alert) => {
    const { sink, subjects } = emailer();
    await sink(alert, { tenantId: "t1" });
    await sink(alert, { tenantId: "t2" });
    expect(subjects()).toEqual([`[AnswerMate] ${alert}`]);
  });

  it("falls back to one window for the alert when the business isn't named as a string", async () => {
    const { sink, subjects } = emailer();
    await sink("billing-no-mandate", {});
    await sink("billing-no-mandate", { tenantId: 42 });
    await sink("billing-no-mandate", { tenantId: null });
    expect(subjects()).toEqual(["[AnswerMate] billing-no-mandate"]);
  });

  it("keeps a business's count apart from the others'", async () => {
    const { sink, advance, subjects } = emailer();
    await sink("billing-payment-failed", { tenantId: "t1" });
    await sink("billing-payment-failed", { tenantId: "t1" });
    await sink("billing-payment-failed", { tenantId: "t2" });
    advance(15 * MINUTE);
    await sink("billing-payment-failed", { tenantId: "t2" });
    await sink("billing-payment-failed", { tenantId: "t1" });
    expect(subjects()).toEqual([
      "[AnswerMate] billing-payment-failed",
      "[AnswerMate] billing-payment-failed",
      "[AnswerMate] billing-payment-failed",
      "[AnswerMate] billing-payment-failed (+1)",
    ]);
  });
});

describe("a send that doesn't happen", () => {
  it("logs the refusal by the allowlist, without the address, and never throws", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const { sink, email } = emailer({ to: "someone-else@example.com" });
    await expect(sink("guardrail-hit", {})).resolves.toBeUndefined();
    expect(email.sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("Alert email not sent", {
      alert: "guardrail-hit",
      reason: expect.any(String) as unknown,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("someone-else@example.com");
  });

  it("sends to any address in production, where the allowlist doesn't apply", async () => {
    const { sink, email } = emailer({
      to: "someone-else@example.com",
      outbound: { nodeEnv: "production", allowlist: new Set() },
    });
    await sink("guardrail-hit", {});
    expect(email.sent.map((sent) => sent.to)).toEqual(["someone-else@example.com"]);
  });

  it("logs a failed send with the error, starts no window, and loses none of the alerts", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const { sink, email, advance, subjects } = emailer();
    email.willFail("Postmark is down");
    await expect(sink("job-dead-lettered", { queue: "notify-sms" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("Alert email failed", {
      alert: "job-dead-lettered",
      error: expect.objectContaining({ message: "Postmark is down" }) as unknown,
    });
    // The provider gets its minute before anything is tried again, however many alerts come.
    await sink("job-dead-lettered", {});
    expect(email.sent).toHaveLength(0);
    // A minute on, not fifteen: the failed send started no window. The email stands in for all
    // three alerts, the failed one included, and shows the newest.
    advance(ALERT_EMAIL_RETRY_FIRST_MS);
    await sink("job-dead-lettered", { queue: "notify-email" });
    expect(subjects()).toEqual(["[AnswerMate] job-dead-lettered (+2)"]);
    expect(email.sent[0]?.text).toContain('"queue": "notify-email"');
  });

  it("never throws when the details can't be turned into JSON", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const { sink, email } = emailer();
    await expect(sink("guardrail-hit", { big: 10n })).resolves.toBeUndefined();
    expect(email.sent).toHaveLength(0);
  });

  it("doesn't take details it can't write out for the provider failing", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const { sink, subjects } = emailer();
    await sink("guardrail-hit", { big: 10n });
    // No wait for a retry: the provider never failed, so the next alert goes straight out.
    await sink("agent-sync-failed", {});
    expect(subjects()).toEqual(["[AnswerMate] agent-sync-failed"]);
  });
});

describe("an email provider that's down", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The sink on a fake clock (its timers and Date both), with a provider down for a while. */
  function outage(downFromMs: number, upAgainMs: number) {
    vi.useFakeTimers({ now: start });
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const delivered = new FakeEmailProvider();
    /** When each send was tried, in minutes from the start. */
    const tries: number[] = [];
    const provider: EmailProvider = {
      send: (message) => {
        const elapsed = Date.now() - start.getTime();
        tries.push(elapsed / MINUTE);
        return elapsed >= downFromMs && elapsed < upAgainMs
          ? Promise.reject(new Error("Postmark is down"))
          : delivered.send(message);
      },
    };
    const sink = alertEmailer({ email: provider, to: TO, outbound: testPolicy });
    return { sink, tries, subjects: () => delivered.sent.map((sent) => sent.subject) };
  }

  it("tries once per retry, however many alerts come, backing off to every 15 minutes", async () => {
    const { sink, tries, subjects } = outage(0, 60 * MINUTE);
    for (const alert of ALERTS) await sink(alert, { tenantId: "t1" });
    // The same alert again while it waits: counted, not tried.
    for (let i = 0; i < 3; i += 1) await sink("sms-undelivered", { tenantId: "t2" });

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    // The first alert's own try, then one per retry: after 1, 2, 4 and 8 minutes, then 15.
    expect(tries.filter((minute) => minute < 60)).toEqual([0, 1, 3, 7, 15, 30, 45]);
    // Back at the hour: one email for each alert, none lost, saying what it stood in for.
    expect([...subjects()].sort()).toEqual(
      ALERTS.map((alert) =>
        alert === "sms-undelivered" ? `[AnswerMate] ${alert} (+3)` : `[AnswerMate] ${alert}`,
      ).sort(),
    );
    // And then nothing more is tried.
    const triedByThen = tries.length;
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(tries).toHaveLength(triedByThen);
    expect(triedByThen).toBe(7 + ALERTS.length);
  });

  it("keeps to the throttle on a retry: an alert emailed just before the outage waits out its window", async () => {
    const { sink, subjects } = outage(MINUTE, 2 * MINUTE);
    await sink("guardrail-hit", {}); // goes
    await vi.advanceTimersByTimeAsync(MINUTE);
    await sink("agent-sync-failed", {}); // fails
    await sink("guardrail-hit", {}); // held: its window runs, and the provider's failing
    // The retry a minute later sends the one that failed, and not the one in its window.
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(subjects()).toEqual(["[AnswerMate] guardrail-hit", "[AnswerMate] agent-sync-failed"]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    await sink("guardrail-hit", {});
    expect(subjects()).toEqual([
      "[AnswerMate] guardrail-hit",
      "[AnswerMate] agent-sync-failed",
      "[AnswerMate] guardrail-hit (+1)",
    ]);
  });
});

describe("raiseAlert", () => {
  it("logs an error line carrying the alert's name and its details", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    raiseAlert("guardrail-hit", { callId: "c1" });
    expect(error).toHaveBeenCalledWith("ALERT guardrail-hit", {
      alert: "guardrail-hit",
      callId: "c1",
    });
  });

  it("logs, and goes no further, when no sink is installed", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    setAlertSink(undefined);
    expect(() => raiseAlert("guardrail-hit")).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("logs a sink that rejects, and never lets it reach the caller", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    setAlertSink(() => Promise.reject(new Error("sink broke")));
    expect(() => raiseAlert("server-error-spike", { count: 3 })).not.toThrow();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("Alert sink failed", {
        alert: "server-error-spike",
        error: expect.objectContaining({ message: "sink broke" }) as unknown,
      }),
    );
  });

  it("stops handing alerts to a sink once it's removed", () => {
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const sink = vi.fn(() => Promise.resolve());
    setAlertSink(sink);
    raiseAlert("guardrail-hit");
    setAlertSink(undefined);
    raiseAlert("guardrail-hit");
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe("installAlertEmail", () => {
  const email = { serverToken: "token_for_tests", from: "calls@example.com" };
  // The config's own shape: a Set it built, where the sink only needs to read one.
  const outbound = { nodeEnv: "test" as const, allowlist: new Set([TO]) };

  it.each([
    ["no email settings", { email: undefined, alertEmail: TO }],
    ["no alert address", { email, alertEmail: undefined }],
    ["neither", { email: undefined, alertEmail: undefined }],
  ])("stays off with %s, and says so", (_label, settings) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    expect(installAlertEmail({ ...settings, outbound })).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Alert emails off: needs ALERT_EMAIL, POSTMARK_SERVER_TOKEN and EMAIL_FROM",
    );
  });

  it("turns on with both, and says so", () => {
    // Only installed, never handed an alert: the real Postmark sender is never called.
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
    expect(installAlertEmail({ email, alertEmail: TO, outbound })).toBe(true);
    expect(info).toHaveBeenCalledWith("Alert emails on");
    setAlertSink(undefined);
  });
});

describe("alertMessage", () => {
  const message = (details: Record<string, unknown>, at = start, suppressed = 0) =>
    alertMessage({ alert: "guardrail-hit", details, at, suppressed, to: TO });

  it.each([
    // Summer: British Summer Time, an hour ahead of UTC.
    ["2026-07-01T12:00:00Z", "1 Jul 2026, 13:00"],
    // The night the clocks go forward: 01:00 UTC is 02:00 BST.
    ["2026-03-29T00:59:00Z", "29 Mar 2026, 00:59"],
    ["2026-03-29T01:00:00Z", "29 Mar 2026, 02:00"],
    // The night they go back: 01:30 comes twice, first as BST then as GMT.
    ["2026-10-25T00:30:00Z", "25 Oct 2026, 01:30"],
    ["2026-10-25T01:30:00Z", "25 Oct 2026, 01:30"],
    // New Year's Eve in winter: GMT, no offset.
    ["2026-12-31T23:59:00Z", "31 Dec 2026, 23:59"],
  ])("gives %s in UK time as %s", (iso, uk) => {
    expect(message({}, new Date(iso)).text).toContain(`At: ${uk} (UK time)`);
  });

  it("redacts phone numbers, emails and postcodes however deep they sit in the details", () => {
    const { text, html } = message({
      jobs: [{ note: "rang from +447700900123" }],
      nested: { contact: { email: "caller@example.com", where: "XQ12 3JL" } },
      error: new Error("couldn't text 07700 900456"),
    });
    for (const secret of [
      "+447700900123",
      "caller@example.com",
      "XQ12 3JL",
      "07700 900456",
      "900456",
    ]) {
      expect(text, secret).not.toContain(secret);
      expect(html, secret).not.toContain(secret);
    }
  });

  it("never carries a transcript or summary, even when handed one by mistake", () => {
    const { text } = message({ transcript: "Caller: my boiler is leaking", summary: "Leak" });
    expect(text).not.toContain("my boiler is leaking");
    expect(text).not.toContain('"Leak"');
  });

  it("copes with details that refer to themselves", () => {
    const loop: Record<string, unknown> = { id: "x" };
    loop["self"] = loop;
    expect(() => message({ loop })).not.toThrow();
  });

  it("escapes every HTML special character in the HTML part", () => {
    const { html } = message({ rule: "<b>&</b>" });
    expect(html).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(html.replace(/^<pre[^>]*>|<\/pre>$/g, "")).not.toMatch(/<|>/);
  });

  it("goes to the given address, with the count in the subject and the text when there is one", () => {
    const held = message({}, start, 4);
    expect(held.to).toBe(TO);
    expect(held.subject).toBe("[AnswerMate] guardrail-hit (+4)");
    expect(held.text).toContain("Plus 4 more of these since the last email about it.");
    const single = message({});
    expect(single.subject).toBe("[AnswerMate] guardrail-hit");
    expect(single.text).not.toContain("Plus");
  });

  it("points at the runbook, which names every alert", () => {
    expect(message({}).text).toContain("docs/RUNBOOK.md, section 11");
  });
});
