// Alert emails through the outbox (alert-email.ts, db/alert-outbox.ts), against real Postgres:
// what waits survives a restart, the throttle and the back-off hold across processes, and two
// processes never email the same alerts. The only file that writes the outbox, so each test
// starts it empty.
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { durableAlertEmailer } from "./alert-email.ts";
import type { AlertSink } from "./alerts.ts";
import { ALERT_KEEP_MS, ALERT_RETRY_FIRST_MS } from "./db/alert-outbox.ts";
import { createPool } from "./db/pool.ts";
import { logger } from "./logger.ts";
import type { EmailMessage, EmailReceipt } from "./providers/email.ts";
import { FakeEmailProvider } from "./providers/email.fake.ts";
import { TEST_DATABASE_URL } from "./testing/databases.ts";

const pool = createPool(TEST_DATABASE_URL);
const TO = "phil@example.com";
const outbound = { nodeEnv: "test" as const, allowlist: new Set([TO]) };
const MINUTE = 60_000;

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await pool.query("DELETE FROM alert_outbox");
});

/** A clock all the "processes" in a test share, moved on by hand. */
function clock(iso = "2031-05-10T14:03:00Z") {
  let at = new Date(iso);
  return { now: () => at, advance: (ms: number) => (at = new Date(at.getTime() + ms)) };
}

/** One process's sender: its own email provider and in-memory fallback, the shared outbox. */
function process(
  time: ReturnType<typeof clock>,
  options: { pool?: pg.Pool; email?: FakeEmailProvider } = {},
) {
  const email = options.email ?? new FakeEmailProvider();
  const fallback = vi.fn<AlertSink>(() => Promise.resolve());
  const sender = durableAlertEmailer({
    pool: options.pool ?? pool,
    email,
    to: TO,
    outbound,
    fallback,
    now: time.now,
  });
  return { email, fallback, ...sender };
}

const row = async (key: string) =>
  (
    await pool.query<{ unsent: number; failures: number; sent_at: Date | null }>(
      "SELECT unsent, failures, sent_at FROM alert_outbox WHERE throttle_key = $1",
      [key],
    )
  ).rows[0];

describe("alert emails through the outbox", () => {
  it("emails an alert straight away, redacted, and records it as sent", async () => {
    const time = clock();
    const api = process(time);
    await api.sink("agent-sync-failed", { tenantId: "t1", note: "caller on +447700900123" });
    expect(api.email.sent).toHaveLength(1);
    expect(api.email.sent[0]?.subject).toBe("[AnswerMate] agent-sync-failed");
    expect(api.email.sent[0]?.text).toContain("At: 10 May 2031, 15:03 (UK time)");
    expect(api.email.sent[0]?.text).toContain("[phone]");
    expect(api.email.sent[0]?.text).not.toContain("+447700900123");
    expect(await row("agent-sync-failed")).toMatchObject({ unsent: 0, failures: 0 });
    // The outbox holds what the email showed: redacted.
    const stored = await pool.query<{ details: unknown }>("SELECT details FROM alert_outbox");
    expect(JSON.stringify(stored.rows[0]?.details)).not.toContain("+447700900123");
  });

  it("holds the rest for 15 minutes, then emails them as one, counted", async () => {
    const time = clock();
    const api = process(time);
    await api.sink("job-dead-lettered", { queue: "a" });
    await api.sink("job-dead-lettered", { queue: "b" });
    await api.sink("job-dead-lettered", { queue: "c" });
    expect(api.email.sent).toHaveLength(1);

    time.advance(14 * MINUTE);
    await api.sweep();
    expect(api.email.sent).toHaveLength(1);

    time.advance(MINUTE);
    await api.sweep();
    expect(api.email.sent).toHaveLength(2);
    expect(api.email.sent[1]?.subject).toBe("[AnswerMate] job-dead-lettered (+1)");
    expect(api.email.sent[1]?.text).toContain('"queue": "c"');
    expect(await row("job-dead-lettered")).toMatchObject({ unsent: 0 });
  });

  it("keeps the throttle across the API and the worker: one email between them", async () => {
    const time = clock();
    const api = process(time);
    const worker = process(time);
    await api.sink("voice-platform-unreachable", {});
    await worker.sink("voice-platform-unreachable", {});
    expect(api.email.sent.length + worker.email.sent.length).toBe(1);
  });

  it("emails each business's alert, even in the same 15 minutes", async () => {
    const time = clock();
    const worker = process(time);
    await worker.sink("billing-no-mandate", { tenantId: "t1" });
    await worker.sink("billing-no-mandate", { tenantId: "t2" });
    expect(worker.email.sent).toHaveLength(2);
  });

  it("keeps an alert through a Postmark outage and a restart, and emails it once Postmark is back", async () => {
    const time = clock();
    const before = process(time);
    before.email.willFail("Postmark is down");
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    await before.sink("billing-payment-failed", { tenantId: "t1" });
    expect(before.email.sent).toHaveLength(0);
    expect(await row("billing-payment-failed:t1")).toMatchObject({ unsent: 1, failures: 1 });

    // The process restarts (a release): a new one, with nothing in memory, sweeps as it starts.
    // Its first try waits out the minute the failure set.
    const after = process(time);
    await after.sweep();
    expect(after.email.sent).toHaveLength(0);
    time.advance(ALERT_RETRY_FIRST_MS);
    await after.sweep();
    expect(after.email.sent).toHaveLength(1);
    expect(after.email.sent[0]?.subject).toBe("[AnswerMate] billing-payment-failed");
    expect(await row("billing-payment-failed:t1")).toMatchObject({ unsent: 0, failures: 0 });
  });

  it("waits longer after each failure in a row: 1 minute, 2, 4, and every 15 at most", async () => {
    const time = clock();
    const api = process(time);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    for (let i = 0; i < 6; i += 1) api.email.willFail("down");
    await api.sink("server-error-spike", {});
    const waits = [1, 2, 4, 8, 15];
    for (const minutes of waits) {
      time.advance(minutes * MINUTE - 1);
      await api.sweep();
      expect(await row("server-error-spike"), `before ${minutes} minutes`).toMatchObject({
        failures: waits.indexOf(minutes) + 1,
      });
      time.advance(1);
      await api.sweep();
    }
    // Six failures, then a 15-minute wait (the most), then it goes.
    expect(await row("server-error-spike")).toMatchObject({ failures: 6 });
    time.advance(15 * MINUTE);
    await api.sweep();
    expect(api.email.sent).toHaveLength(1);
  });

  it("stops at the first failure in a sweep: the others wait for their own retry", async () => {
    const time = clock();
    const api = process(time);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    api.email.willFail("down").willFail("down");
    await api.sink("agent-sync-failed", {});
    await api.sink("guardrail-hit", {});
    expect(api.email.sent).toHaveLength(0);

    // Both due again in a minute; Postmark fails once more on the first and the second isn't tried.
    time.advance(ALERT_RETRY_FIRST_MS);
    api.email.willFail("still down");
    await api.sweep();
    expect(api.email.sent).toHaveLength(0);
    expect(await row("guardrail-hit")).toMatchObject({ failures: 2 });

    time.advance(2 * MINUTE);
    await api.sweep();
    expect(api.email.sent.map((sent) => sent.subject).sort()).toEqual([
      "[AnswerMate] agent-sync-failed",
      "[AnswerMate] guardrail-hit",
    ]);
  });

  it("never emails the same alerts from two processes sweeping at once", async () => {
    const time = clock();
    const first = process(time);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    first.email.willFail("down");
    await first.sink("job-dead-lettered", {});
    time.advance(ALERT_RETRY_FIRST_MS);

    // A slow send in one process while the other sweeps: the claim keeps the second away.
    let release!: () => void;
    const slow = new FakeEmailProvider();
    const send = slow.send.bind(slow);
    slow.send = (message: EmailMessage): Promise<EmailReceipt> =>
      new Promise((resolve) => (release = () => resolve(send(message))));
    const api = process(time, { email: slow });
    const worker = process(time);
    const sweeping = api.sweep();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await worker.sweep();
    release();
    await sweeping;
    expect(slow.sent.length + worker.email.sent.length).toBe(1);
  });

  it("keeps alerts raised while an email was on its way for the next one", async () => {
    const time = clock();
    let release!: () => void;
    const slow = new FakeEmailProvider();
    const send = slow.send.bind(slow);
    slow.send = (message: EmailMessage): Promise<EmailReceipt> =>
      new Promise((resolve) => (release = () => resolve(send(message))));
    const api = process(time, { email: slow });
    const sending = api.sink("job-dead-lettered", { queue: "first" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await api.sink("job-dead-lettered", { queue: "second" });
    release();
    await sending;
    // Sends at once from here on.
    slow.send = send;
    expect(await row("job-dead-lettered")).toMatchObject({ unsent: 1 });
    time.advance(15 * MINUTE);
    await api.sweep();
    expect(slow.sent.at(-1)?.text).toContain('"queue": "second"');
  });

  it("counts an alert the allowlist turns away as done", async () => {
    const time = clock();
    const sender = durableAlertEmailer({
      pool,
      email: new FakeEmailProvider(),
      to: "someone-else@example.com",
      outbound,
      fallback: () => Promise.resolve(),
      now: time.now,
    });
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    await sender.sink("agent-sync-failed", {});
    expect(await row("agent-sync-failed")).toMatchObject({ unsent: 0 });
  });

  it("emails from memory when the outbox can't be reached", async () => {
    const time = clock();
    const down = {
      query: () => Promise.reject(new Error("connection refused")),
    } as unknown as pg.Pool;
    const api = process(time, { pool: down });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    await api.sink("server-error-spike", { count: 9 });
    expect(api.fallback).toHaveBeenCalledWith("server-error-spike", { count: 9 });
    expect(warn).toHaveBeenCalledWith(
      "Alert outbox unreachable: this alert's email waits in memory",
      expect.objectContaining({ alert: "server-error-spike" }),
    );
  });

  it("logs details it can't write out, and stores nothing", async () => {
    const time = clock();
    const api = process(time);
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    await api.sink("agent-sync-failed", { count: 10n });
    expect(error).toHaveBeenCalledWith(
      "Alert email failed",
      expect.objectContaining({ alert: "agent-sync-failed" }),
    );
    expect(api.email.sent).toHaveLength(0);
    expect(await row("agent-sync-failed")).toBeUndefined();
  });

  it("deletes a window with nothing waiting a day after its last email, and keeps one with alerts waiting", async () => {
    const time = clock();
    const api = process(time);
    await api.sink("agent-sync-failed", {});
    await api.sink("job-dead-lettered", {});
    await api.sink("job-dead-lettered", {});
    time.advance(ALERT_KEEP_MS - 1);
    // The held job-dead-lettered goes now (its 15 minutes are long past), so both are sent.
    await api.sweep();
    expect(await row("agent-sync-failed")).toBeDefined();
    time.advance(2);
    await api.sweep();
    expect(await row("agent-sync-failed")).toBeUndefined();
    // Sent a moment ago, at the last sweep: kept another day.
    expect(await row("job-dead-lettered")).toBeDefined();
  });
});
