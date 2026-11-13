// Supplier costs for the Admin page (core/service-costs.ts): trends, each supplier's price
// rules, the warnings when a tier is about to change either way, and the totals.
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_SPEND_CAPS,
  AZURE_OTHER_PENCE,
  DOMAIN_PENCE_PER_MONTH,
  POSTMARK_TIERS,
  RETELL,
  cheapestPostmarkTier,
  goCardlessFeePence,
  postmarkPence,
  scaled,
  serviceCosts,
  trend,
  type ServiceReadings,
  type WindowUsage,
} from "./service-costs.ts";

const NO_PENCE: WindowUsage["pence"] = {
  voicePlatform: 0,
  languageModel: 0,
  texts: 0,
  phoneMinutes: 0,
  numbers: 0,
  transcription: 0,
};

const usage = (
  over: Partial<Omit<WindowUsage, "pence">> = {},
  pence: Partial<WindowUsage["pence"]> = {},
): WindowUsage => ({
  calls: 0,
  callSeconds: 0,
  peakConcurrentCalls: 0,
  emails: 0,
  textSegments: 0,
  payments: [],
  ...over,
  pence: { ...NO_PENCE, ...pence },
});

const readings = (over: Partial<ServiceReadings> = {}): ServiceReadings => ({
  last: usage(),
  previous: usage(),
  activeNumbers: 0,
  logins: 0,
  bills: [],
  ...over,
});

const service = (result: ReturnType<typeof serviceCosts>, id: string) => {
  const found = result.services.find((each) => each.id === id);
  if (!found) throw new Error(`no service ${id}`);
  return found;
};

describe("trend", () => {
  it("takes the same step again, and gives the change in percent", () => {
    expect(trend(150, 100)).toEqual({ last: 150, previous: 100, next: 200, ratePercent: 50 });
    expect(trend(80, 100)).toEqual({ last: 80, previous: 100, next: 60, ratePercent: -20 });
  });

  it("never heads below zero", () => {
    expect(trend(10, 100).next).toBe(0);
  });

  it("has no rate when the window before had nothing", () => {
    expect(trend(40, 0)).toEqual({ last: 40, previous: 0, next: 80, ratePercent: null });
    expect(trend(0, 0)).toEqual({ last: 0, previous: 0, next: 0, ratePercent: null });
  });
});

describe("scaled", () => {
  it("moves a cost with what drives it", () => {
    expect(scaled(1000, trend(150, 100))).toBe(1333);
    expect(scaled(1000, trend(80, 100))).toBe(750);
  });

  it("leaves a cost alone when its driver has no use yet", () => {
    expect(scaled(87, trend(0, 0))).toBe(87);
  });
});

describe("GoCardless's fee", () => {
  it("is 1% plus 20p", () => {
    expect(goCardlessFeePence(9900)).toBe(119);
    expect(goCardlessFeePence(4900)).toBe(69);
  });

  it("is capped at £4", () => {
    expect(goCardlessFeePence(38_000)).toBe(400);
    expect(goCardlessFeePence(100_000)).toBe(400);
  });

  it("is nothing on nothing", () => {
    expect(goCardlessFeePence(0)).toBe(0);
  });
});

describe("Postmark's tiers", () => {
  it("charges the plan's price inside its emails", () => {
    expect(postmarkPence("free", 100)).toBe(0);
    expect(postmarkPence("10k", 10_000)).toBe(1200);
  });

  it("can't send past the free plan's 100", () => {
    expect(postmarkPence("free", 101)).toBeNull();
  });

  it("charges each started 1,000 extra on a paid plan", () => {
    // 10,001 emails: one extra thousand at $1.80 (£1.44).
    expect(postmarkPence("10k", 10_001)).toBe(1200 + 144);
    expect(postmarkPence("10k", 12_000)).toBe(1200 + 288);
  });

  it("finds the cheapest tier, counting extras", () => {
    expect(cheapestPostmarkTier(50).id).toBe("free");
    expect(cheapestPostmarkTier(101).id).toBe("10k");
    // 30,000 on the 10,000 plan is £12 + 20 x £1.44 = £40.80; the 50,000 plan is £44.
    expect(cheapestPostmarkTier(30_000)).toMatchObject({ id: "10k", pence: 4080 });
    // 40,000 on the 10,000 plan is £55.20: the 50,000 plan wins.
    expect(cheapestPostmarkTier(40_000)).toMatchObject({ id: "50k", pence: 4400 });
  });

  it("lists tiers from smallest to largest", () => {
    const emails = POSTMARK_TIERS.map((tier) => tier.emails);
    expect(emails).toEqual([...emails].sort((a, b) => a - b));
  });
});

describe("serviceCosts", () => {
  it("lists every supplier, each with one current tier", () => {
    const result = serviceCosts(readings());
    expect(result.services.map((each) => each.id)).toEqual([
      "retell",
      "twilio",
      "anthropic",
      "postmark",
      "gocardless",
      "azure",
      "clerk",
      "uptimerobot",
      "domain",
    ]);
    for (const each of result.services) {
      expect(each.tiers.filter((tier) => tier.current)).toHaveLength(1);
    }
  });

  it("costs only the fixed services when nothing has happened", () => {
    const result = serviceCosts(readings());
    const fixed = 1044 + AZURE_OTHER_PENCE + DOMAIN_PENCE_PER_MONTH;
    expect(result.totals).toEqual({
      nowPence: fixed,
      nextPence: fixed,
      incomePence: 0,
      marginPence: -fixed,
      payingBusinesses: 0,
      perMinuteHundredths: null,
    });
  });

  it("adds up the metered parts and projects them with their drivers", () => {
    const result = serviceCosts(
      readings({
        last: usage(
          { calls: 60, callSeconds: 9000, emails: 60, textSegments: 120 },
          {
            voicePlatform: 1500,
            languageModel: 30,
            texts: 508,
            phoneMinutes: 160,
            numbers: 174,
            transcription: 10,
          },
        ),
        previous: usage({ calls: 40, callSeconds: 6000, emails: 40, textSegments: 80 }),
        bills: [9900, 9900],
      }),
    );
    // Minutes 100 to 150, so 200 next: every minute-driven cost times 200/150.
    expect(result.growth.minutes).toEqual({ last: 150, previous: 100, next: 200, ratePercent: 50 });
    expect(service(result, "retell").pence).toEqual({ now: 1500, next: 2000 });
    // Twilio: 160 + 10 minute-driven, 508 of texts (120 segments to 160), 174 of numbers, fixed.
    expect(service(result, "twilio").pence).toEqual({
      now: 160 + 10 + 508 + 174,
      next: 227 + 677 + 174,
    });
    // Anthropic follows calls: 60 to 80.
    expect(service(result, "anthropic").pence).toEqual({ now: 30, next: 40 });
    // (1500 + 30 + 508 + 160 + 10) pence over 150 minutes = 14.72p a minute.
    expect(result.totals.perMinuteHundredths).toBe(1472);
    expect(result.totals.incomePence).toBe(19800);
    expect(result.totals.marginPence).toBe(19800 - result.totals.nowPence);
    expect(result.totals.nowPence).toBe(
      result.services.reduce((total, each) => total + each.pence.now, 0),
    );
    expect(result.totals.nextPence).toBe(
      result.services.reduce((total, each) => total + each.pence.next, 0),
    );
  });

  it("charges GoCardless's fee on each payment, and next month's on each paying business", () => {
    const result = serviceCosts(
      readings({
        last: usage({ payments: [9900, 4900] }),
        // Two at £99 and a pilot's £49: each has its own fee.
        bills: [9900, 9900, 4900],
      }),
    );
    expect(service(result, "gocardless").pence).toEqual({ now: 119 + 69, next: 119 + 119 + 69 });
    expect(result.totals).toMatchObject({ incomePence: 24700, payingBusinesses: 3 });
  });

  describe("the suppliers' own figures", () => {
    const busy = {
      last: usage(
        { calls: 60, callSeconds: 9000, emails: 9, textSegments: 120 },
        { phoneMinutes: 160, transcription: 10, texts: 508, numbers: 174 },
      ),
      previous: usage({ calls: 40, callSeconds: 6000, emails: 4, textSegments: 80 }),
    };

    it("are estimates, marked so, when no account could be read", () => {
      const result = serviceCosts(readings(busy));
      expect(result.services.every((each) => !each.measured)).toBe(true);
      expect(service(result, "postmark").usage).toMatchObject({
        label: "Emails (our count, without alerts)",
        used: 9,
      });
    });

    it("put Twilio's own total in place of ours, moving it as our estimate moves", () => {
      const result = serviceCosts(
        readings({ ...busy, accounts: { twilioPence: 1000, postmark: null } }),
      );
      const twilio = service(result, "twilio");
      // Ours: 852 now, 1,078 next. Twilio says 1,000, so next is 1,000 x 1,078 / 852.
      expect(twilio.pence).toEqual({ now: 1000, next: 1265 });
      expect(twilio.measured).toBe(true);
      expect(result.totals.nowPence).toBe(
        result.services.reduce((total, each) => total + each.pence.now, 0),
      );
    });

    it("keep Twilio's total as it is when we have no estimate to move it by", () => {
      const result = serviceCosts(readings({ accounts: { twilioPence: 87, postmark: null } }));
      expect(service(result, "twilio").pence).toEqual({ now: 87, next: 87 });
    });

    it("count Postmark's emails, alerts included, for the plan and its warnings", () => {
      const result = serviceCosts(
        readings({
          ...busy,
          accounts: {
            twilioPence: null,
            postmark: {
              last: { sent: 70, bounced: 0, spamComplaints: 0 },
              previous: { sent: 40, bounced: 0, spamComplaints: 0 },
            },
          },
        }),
      );
      const postmark = service(result, "postmark");
      expect(postmark.measured).toBe(true);
      expect(postmark.usage).toMatchObject({ label: "Emails (Postmark's count)", used: 70 });
      expect(result.growth.emails).toEqual({ last: 70, previous: 40, next: 100, ratePercent: 75 });
      // Ours said 9 and would never have warned; Postmark's 70 heads for the plan's 100.
      expect(postmark.warnings[0]?.text).toContain("100 emails a month is close to the 100");
    });
  });

  describe("warnings", () => {
    it("has none on a quiet month, apart from the database's connections", () => {
      const result = serviceCosts(readings());
      const warned = result.services.filter((each) => each.warnings.length > 0);
      expect(warned.map((each) => each.id)).toEqual(["azure"]);
      expect(warned[0]?.warnings[0]?.direction).toBe("up");
      expect(warned[0]?.warnings[0]?.text).toContain("35 of the database's 35 connections");
    });

    it("warns that emails are close to the free plan's limit", () => {
      const result = serviceCosts(
        readings({ last: usage({ emails: 80 }), previous: usage({ emails: 80 }) }),
      );
      const [warning] = service(result, "postmark").warnings;
      expect(warning?.direction).toBe("up");
      expect(warning?.text).toContain("80 emails a month is close to the 100");
      expect(service(result, "postmark").pence).toEqual({ now: 0, next: 0 });
    });

    it("warns that emails would stop past the free plan, and costs the plan that fits", () => {
      const result = serviceCosts(
        readings({ last: usage({ emails: 90 }), previous: usage({ emails: 60 }) }),
      );
      const postmark = service(result, "postmark");
      expect(postmark.warnings[0]?.text).toContain("120 emails a month is over the 100");
      expect(postmark.warnings[0]?.text).toContain("Basic 10,000 is £12.00 a month");
      expect(postmark.pence).toEqual({ now: 0, next: 1200 });
    });

    it("doesn't warn about emails well inside the plan", () => {
      const result = serviceCosts(
        readings({ last: usage({ emails: 14 }), previous: usage({ emails: 10 }) }),
      );
      expect(service(result, "postmark").warnings).toEqual([]);
    });

    it("warns as calls at once near Retell's included lines, and charges past them", () => {
      const near = serviceCosts(readings({ last: usage({ peakConcurrentCalls: 16 }) }));
      expect(service(near, "retell").warnings[0]?.text).toContain("16 calls at once is close");
      expect(service(near, "retell").pence.now).toBe(0);

      const over = serviceCosts(
        readings({
          last: usage({ peakConcurrentCalls: 22 }),
          previous: usage({ peakConcurrentCalls: 22 }),
        }),
      );
      expect(service(over, "retell").warnings[0]?.text).toContain("22 calls at once passed the 20");
      expect(service(over, "retell").pence.now).toBe(2 * RETELL.extraConcurrentCallPence);

      const fine = serviceCosts(readings({ last: usage({ peakConcurrentCalls: 15 }) }));
      expect(service(fine, "retell").warnings).toEqual([]);
    });

    it("warns when AI summaries head for Anthropic's first spend cap", () => {
      const cap = ANTHROPIC_SPEND_CAPS[0]!.capPence;
      // Calls 50 to 100, so 150 next: half the cap now heads for 75% of it. Not yet.
      const calm = serviceCosts(
        readings({
          last: usage({ calls: 100 }, { languageModel: cap * 0.5 }),
          previous: usage({ calls: 50 }),
        }),
      );
      expect(service(calm, "anthropic").warnings).toEqual([]);
      // 60% of the cap now heads for 90%.
      const close = serviceCosts(
        readings({
          last: usage({ calls: 100 }, { languageModel: cap * 0.6 }),
          previous: usage({ calls: 50 }),
        }),
      );
      expect(service(close, "anthropic").warnings[0]?.text).toContain("Start tier");
    });

    it("warns when Postmark's bounces or spam complaints near the limits it pauses an account at", () => {
      const counts = (sent: number, bounced: number, spamComplaints: number) =>
        readings({
          accounts: {
            twilioPence: null,
            postmark: {
              last: { sent, bounced, spamComplaints },
              previous: { sent, bounced: 0, spamComplaints: 0 },
            },
          },
        });
      // 1 bounce in 14 is 7.1%: past half of Postmark's 10%.
      const bounced = service(serviceCosts(counts(14, 1, 0)), "postmark").warnings;
      expect(bounced.map((each) => each.text)).toEqual([
        "1 of 14 emails bounced (7.1%). Postmark pauses an account past 10%: check the addresses on the businesses' Account pages.",
      ]);
      // 1 complaint in 14 is far past 1 in 1,000.
      const complained = service(serviceCosts(counts(14, 0, 1)), "postmark").warnings;
      expect(complained[0]?.text).toContain("1 of 14 emails were reported as spam (7.14%)");
      // 1 bounce in 40 is 2.5%: fine.
      expect(service(serviceCosts(counts(40, 1, 0)), "postmark").warnings).toEqual([]);
      // Nothing sent: nothing to divide by.
      expect(service(serviceCosts(counts(0, 0, 0)), "postmark").warnings).toEqual([]);
    });

    it("warns as logins near Clerk's free plan", () => {
      const result = serviceCosts(readings({ logins: 40_000 }));
      expect(service(result, "clerk").warnings[0]?.text).toContain("40000 logins is close");
      expect(service(serviceCosts(readings({ logins: 12 })), "clerk").warnings).toEqual([]);
    });
  });
});
