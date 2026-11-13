// Reading Twilio's and Postmark's own figures for the admin's costs (supplier-accounts.ts):
// the days asked for, a supplier that isn't set up, one that fails, and what the costs get.
import { describe, expect, it } from "vitest";
import type { readServiceUsage } from "../db/cross-tenant.ts";
import { PostmarkApiError } from "../providers/postmark-stats.ts";
import { FakeEmailStats, FakeTwilioUsage } from "../providers/supplier-readings.fake.ts";
import { TwilioApiError } from "../providers/twilio.ts";
import { accountRanges, readSupplierAccounts } from "./supplier-accounts.ts";

type Usage = Awaited<ReturnType<typeof readServiceUsage>>;

const window = (emails: number, pence: Partial<Usage["last"]["pence"]> = {}) => ({
  calls: 0,
  callSeconds: 0,
  peakConcurrentCalls: 0,
  emails,
  textSegments: 0,
  payments: [],
  pence: {
    voicePlatform: 0,
    languageModel: 0,
    texts: 0,
    phoneMinutes: 0,
    numbers: 0,
    transcription: 0,
    ...pence,
  },
});

const usage: Usage = {
  from: new Date("2026-10-14T12:00:00Z"),
  last: window(9, {
    phoneMinutes: 20,
    transcription: 2,
    texts: 40,
    numbers: 87,
    voicePlatform: 900,
  }),
  previous: window(4),
  activeNumbers: 1,
  logins: 2,
};

const NOW = new Date("2026-11-13T12:00:00Z");

describe("accountRanges", () => {
  it("is the last 30 days, today included, and the 30 before, with no gap or overlap", () => {
    expect(accountRanges(NOW)).toEqual({
      last: { from: "2026-10-15", to: "2026-11-13" },
      previous: { from: "2026-09-15", to: "2026-10-14" },
    });
  });

  it("counts whole UTC days across the clocks going back", () => {
    expect(accountRanges(new Date("2026-10-26T00:30:00Z")).last).toEqual({
      from: "2026-09-27",
      to: "2026-10-26",
    });
  });
});

describe("readSupplierAccounts", () => {
  it("says a supplier isn't set up, and gives the costs nothing from it", async () => {
    const { view, forCosts } = await readSupplierAccounts({}, NOW, usage);
    expect(view).toEqual({
      from: "2026-10-15",
      to: "2026-11-13",
      twilio: { status: "off", reason: "Twilio isn't set up on this server" },
      postmark: { status: "off", reason: "Postmark isn't set up on this server" },
    });
    expect(forCosts).toEqual({ twilioPence: null, postmark: null });
  });

  it("gives each supplier's own figures beside ours, and passes them to the costs", async () => {
    const twilio = new FakeTwilioUsage();
    twilio.reading = {
      totalPence: 151,
      lines: [
        { category: "calls-inbound-local", description: "Calls", pence: 21, usage: "28 minutes" },
      ],
    };
    const email = new FakeEmailStats();
    email.readings.set("2026-10-15", { sent: 14, bounced: 1, spamComplaints: 0 });
    email.readings.set("2026-09-15", { sent: 6, bounced: 0, spamComplaints: 0 });

    const { view, forCosts } = await readSupplierAccounts({ twilio, email }, NOW, usage);
    expect(twilio.asked).toEqual([{ from: "2026-10-15", to: "2026-11-13" }]);
    expect(email.asked).toEqual([
      { from: "2026-10-15", to: "2026-11-13" },
      { from: "2026-09-15", to: "2026-10-14" },
    ]);
    expect(view.twilio).toEqual({
      status: "read",
      totalPence: 151,
      // Ours: phone minutes, transcription, texts and numbers. Not Retell's voice platform.
      estimatePence: 20 + 2 + 40 + 87,
      lines: twilio.reading.lines,
    });
    expect(view.postmark).toEqual({
      status: "read",
      sent: 14,
      previousSent: 6,
      ourCount: 9,
      bounced: 1,
      spamComplaints: 0,
    });
    expect(forCosts).toEqual({
      twilioPence: 151,
      postmark: {
        last: { sent: 14, bounced: 1, spamComplaints: 0 },
        previous: { sent: 6, bounced: 0, spamComplaints: 0 },
      },
    });
  });

  it("says how a supplier failed, with nothing from its answer, and still reads the other", async () => {
    const twilio = new FakeTwilioUsage();
    twilio.failure = new TwilioApiError(401, "/Usage/Records.json", "Authenticate");
    const email = new FakeEmailStats();
    email.readings.set("2026-10-15", { sent: 3, bounced: 0, spamComplaints: 0 });

    const { view, forCosts } = await readSupplierAccounts({ twilio, email }, NOW, usage);
    expect(view.twilio).toEqual({ status: "failed", reason: "It answered HTTP 401" });
    expect(view.postmark).toMatchObject({ status: "read", sent: 3 });
    expect(forCosts.twilioPence).toBeNull();
  });

  it("says when a supplier didn't answer in time", async () => {
    const email = new FakeEmailStats();
    email.failure = new DOMException("The operation timed out.", "TimeoutError");
    const { view, forCosts } = await readSupplierAccounts({ email }, NOW, usage);
    expect(view.postmark).toEqual({
      status: "failed",
      reason: "It didn't answer within 8 seconds",
    });
    expect(forCosts.postmark).toBeNull();
  });

  it("counts Postmark as failed if either window can't be read", async () => {
    const email = new FakeEmailStats();
    email.failure = new PostmarkApiError(500, "Internal error");
    const { view } = await readSupplierAccounts({ email }, NOW, usage);
    expect(view.postmark).toEqual({ status: "failed", reason: "It answered HTTP 500" });
  });
});
