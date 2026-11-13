// What the money screens show (costs.ts): the Account page's bill and minutes in parts, the
// days' columns, and the Admin page's supplier figures, changes and warnings.
import type { BillingView, CostRowView, ServiceCostView } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  billParts,
  businessMargin,
  costHeadlines,
  dayColumns,
  minuteParts,
  penceChange,
  perMinuteLabel,
  projectionText,
  rankedServices,
  rateLabel,
  tierWarnings,
  usageLabel,
} from "./costs.ts";

type Period = NonNullable<BillingView["period"]>;

const plan = {
  name: "AI Answering",
  monthlyPence: 9900,
  includedMinutes: 200,
  overagePencePerMinute: 20,
};

const period = (over: Partial<Period> = {}): Period => ({
  start: "2026-11-14",
  end: "2026-12-14",
  month: 3,
  feePence: 9900,
  billableSeconds: 4321,
  soFar: { overageMinutes: 0, overagePence: 0, totalPence: 9900 },
  projected: null,
  days: [],
  ...over,
});

const over = period({
  billableSeconds: 12630,
  soFar: { overageMinutes: 11, overagePence: 220, totalPence: 10120 },
});

const service = (set: Partial<ServiceCostView>): ServiceCostView => ({
  id: "x",
  name: "X",
  purpose: "",
  plan: "",
  pricing: "",
  usage: null,
  tiers: [],
  pence: { now: 0, next: 0 },
  drivenBy: "",
  warnings: [],
  ...set,
});

describe("billParts", () => {
  it("is all plan when no extra minutes have been used", () => {
    const bill = billParts(period());
    expect(bill.total).toBe("£99.00");
    expect(bill.summary).toBe("£99.00 for the plan. No extra minutes so far.");
    expect(bill.parts.map((part) => [part.label, part.value, part.percent])).toEqual([
      ["Plan", "£99.00", 100],
      ["Extra minutes", "£0.00", 0],
    ]);
  });

  it("splits the bar between the plan and the extra minutes", () => {
    const bill = billParts(over);
    expect(bill.total).toBe("£101.20");
    expect(bill.summary).toBe(
      "£99.00 for the plan, plus £2.20 for 11 minutes over the included ones.",
    );
    expect(bill.parts.map((part) => [part.value, part.percent])).toEqual([
      ["£99.00", 97.8],
      ["£2.20", 2.2],
    ]);
    expect(bill.parts[0]!.percent + bill.parts[1]!.percent).toBe(100);
  });

  it("says one minute, not one minutes", () => {
    const one = billParts(
      period({ soFar: { overageMinutes: 1, overagePence: 20, totalPence: 9920 } }),
    );
    expect(one.summary).toContain("for 1 minute over");
  });

  it("shows a pilot's free month as nothing, with no bar to split", () => {
    const free = billParts(
      period({ feePence: 0, soFar: { overageMinutes: 0, overagePence: 0, totalPence: 0 } }),
    );
    expect(free.total).toBe("£0.00");
    expect(free.parts.map((part) => part.percent)).toEqual([0, 0]);
  });
});

describe("minuteParts", () => {
  it("fills the bar by the included minutes used, rounding the month up once", () => {
    // 4,321 seconds is 72 minutes and a second: 73.
    const used = minuteParts(period(), plan);
    expect(used.used).toBe(73);
    expect(used.label).toBe("73 of 200 included minutes used");
    expect(used.left).toBe("127 minutes left");
    expect(used.parts.map((part) => [part.label, part.value, part.percent])).toEqual([
      ["Included", "73 minutes", 36.5],
      ["Extra", "0 minutes", 0],
    ]);
  });

  it("grows the bar past the plan instead of overflowing, with the extra as its own part", () => {
    const used = minuteParts(over, plan);
    expect(used.used).toBe(211);
    expect(used.left).toBe("11 minutes over, at 20p each");
    // 200 and 11 of 211.
    expect(used.parts.map((part) => [part.value, part.percent])).toEqual([
      ["200 minutes", 94.8],
      ["11 minutes", 5.2],
    ]);
  });

  it("is empty before any call", () => {
    const none = minuteParts(period({ billableSeconds: 0 }), plan);
    expect(none.left).toBe("200 minutes left");
    expect(none.parts.map((part) => part.percent)).toEqual([0, 0]);
  });
});

describe("projectionText", () => {
  it("says nothing while it's too early", () => {
    expect(projectionText(period())).toBeNull();
  });

  it("names the month's last day, the minutes and the bill it's heading for", () => {
    expect(
      projectionText(
        period({ projected: { minutes: 309, overagePence: 2180, totalPence: 12080 } }),
      ),
    ).toBe(
      "At this rate: about 309 minutes by 13 Dec 2026, so about £120.80 (£21.80 of it extra minutes).",
    );
  });

  it("says so when the month is heading to stay inside the plan", () => {
    expect(
      projectionText(period({ projected: { minutes: 150, overagePence: 0, totalPence: 9900 } })),
    ).toBe("At this rate: about 150 minutes by 13 Dec 2026, inside the plan, so £99.00.");
  });
});

describe("dayColumns", () => {
  it("draws each day against the busiest, in whole minutes rounded up", () => {
    expect(
      dayColumns([
        { date: "2026-11-14", billableSeconds: 9000 },
        { date: "2026-11-15", billableSeconds: 0 },
        { date: "2026-11-16", billableSeconds: 3630 },
      ]),
    ).toEqual([
      {
        date: "2026-11-14",
        day: "14 Nov 2026",
        minutes: 150,
        percent: 100,
        label: "14 Nov 2026: 150 minutes",
      },
      {
        date: "2026-11-15",
        day: "15 Nov 2026",
        minutes: 0,
        percent: 0,
        label: "15 Nov 2026: 0 minutes",
      },
      {
        date: "2026-11-16",
        day: "16 Nov 2026",
        minutes: 61,
        percent: 40.7,
        label: "16 Nov 2026: 61 minutes",
      },
    ]);
  });

  it("has no heights when no day has a call", () => {
    expect(dayColumns([{ date: "2026-11-14", billableSeconds: 0 }])[0]?.percent).toBe(0);
    expect(dayColumns([])).toEqual([]);
  });
});

describe("penceChange", () => {
  it("marks a rise as a warning and a fall as good news", () => {
    expect(penceChange(1000, 1120)).toEqual({ label: "+£1.20", tone: "warning" });
    expect(penceChange(1000, 960)).toEqual({ label: "-£0.40", tone: "success" });
    expect(penceChange(1000, 1000)).toEqual({ label: "No change", tone: "neutral" });
  });
});

describe("rateLabel", () => {
  const trend = (last: number, previous: number, ratePercent: number | null) => ({
    last,
    previous,
    next: 0,
    ratePercent,
  });

  it("shows growth and decline with their signs", () => {
    expect(rateLabel(trend(150, 100, 50))).toBe("+50%");
    expect(rateLabel(trend(80, 100, -20))).toBe("-20%");
    expect(rateLabel(trend(100, 100, 0))).toBe("No change");
  });

  it("calls a first month new, and nothing at all a dash", () => {
    expect(rateLabel(trend(40, 0, null))).toBe("New");
    expect(rateLabel(trend(0, 0, null))).toBe("–");
  });
});

describe("usageLabel", () => {
  it("shows what's used against a limit, or alone without one", () => {
    expect(usageLabel({ label: "Emails", used: 14, limit: 100, unit: "emails" })).toBe(
      "14 of 100 emails",
    );
    expect(usageLabel({ label: "Numbers", used: 2, limit: null, unit: "numbers" })).toBe(
      "2 numbers",
    );
    expect(usageLabel({ label: "Numbers", used: 1, limit: null, unit: "numbers" })).toBe(
      "1 number",
    );
    expect(usageLabel({ label: "Logins", used: 12, limit: 50000, unit: "people" })).toBe(
      "12 of 50,000 people",
    );
  });

  it("shows money as money", () => {
    expect(usageLabel({ label: "Spend", used: 30, limit: 40000, unit: "pence" })).toBe(
      "£0.30 of £400.00",
    );
  });
});

describe("rankedServices", () => {
  it("puts the dearest first, with every bar against it", () => {
    expect(
      rankedServices([
        service({ id: "a", name: "Cheap", pence: { now: 250, next: 0 } }),
        service({ id: "b", name: "Dear", pence: { now: 1000, next: 0 } }),
        service({ id: "c", name: "Free", pence: { now: 0, next: 0 } }),
      ]),
    ).toEqual([
      { id: "b", name: "Dear", value: "£10.00", percent: 100 },
      { id: "a", name: "Cheap", value: "£2.50", percent: 25 },
      { id: "c", name: "Free", value: "£0.00", percent: 0 },
    ]);
  });

  it("keeps equal costs in name order, and draws nothing when nothing costs anything", () => {
    const ranked = rankedServices([
      service({ id: "b", name: "Beta" }),
      service({ id: "a", name: "Alpha" }),
    ]);
    expect(ranked.map((each) => [each.name, each.percent])).toEqual([
      ["Alpha", 0],
      ["Beta", 0],
    ]);
  });
});

describe("tierWarnings", () => {
  it("lists every warning with its supplier, costs going up before savings", () => {
    expect(
      tierWarnings([
        service({
          id: "a",
          name: "Alpha",
          warnings: [{ direction: "down", text: "Cheaper tier fits." }],
        }),
        service({ id: "b", name: "Beta" }),
        service({
          id: "c",
          name: "Gamma",
          warnings: [{ direction: "up", text: "Close to the limit." }],
        }),
      ]),
    ).toEqual([
      { id: "c-0", name: "Gamma", direction: "up", text: "Close to the limit." },
      { id: "a-0", name: "Alpha", direction: "down", text: "Cheaper tier fits." },
    ]);
  });
});

describe("costHeadlines", () => {
  const totals = {
    nowPence: 5400,
    nextPence: 6100,
    incomePence: 19800,
    marginPence: 14400,
    payingBusinesses: 2,
    perMinuteHundredths: 1472,
  };

  it("shows the five figures with what each means", () => {
    expect(costHeadlines(totals).map((each) => [each.label, each.value, each.hint])).toEqual([
      ["Costs, last 30 days", "£54.00", "Every supplier, estimated"],
      ["Heading for, next 30 days", "£61.00", "+£7.00 on the last 30"],
      ["Income, billing months so far", "£198.00", "2 paying businesses, before VAT"],
      ["Income less costs", "£144.00", "Income is ahead of costs"],
      ["Cost of a call minute", "14.72p", "Calls, texts and summaries only"],
    ]);
    expect(costHeadlines(totals).find((each) => each.key === "margin")?.tone).toBe("success");
  });

  it("shows costs ahead of income in red, and says one business", () => {
    const behind = costHeadlines({
      ...totals,
      nextPence: 5400,
      incomePence: 0,
      marginPence: -5400,
      payingBusinesses: 1,
      perMinuteHundredths: null,
    });
    expect(behind.find((each) => each.key === "margin")).toMatchObject({
      value: "-£54.00",
      hint: "Costs are ahead of income",
      tone: "danger",
    });
    expect(behind.find((each) => each.key === "next")?.hint).toBe("No change expected");
    expect(behind.find((each) => each.key === "income")?.hint).toBe(
      "1 paying business, before VAT",
    );
    expect(behind.find((each) => each.key === "minute")?.value).toBe("–");
  });
});

describe("perMinuteLabel", () => {
  it("shows pence to two places", () => {
    expect(perMinuteLabel(1472)).toBe("14.72p");
    expect(perMinuteLabel(50)).toBe("0.50p");
  });
});

describe("businessMargin", () => {
  const row = (billPence: number | null, total: number) =>
    ({ billPence, pence: { total } }) as CostRowView;

  it("is the bill so far less the costs, and nothing for a business that doesn't pay", () => {
    expect(businessMargin(row(9900, 1500))).toBe(8400);
    expect(businessMargin(row(0, 300))).toBe(-300);
    expect(businessMargin(row(null, 300))).toBeNull();
  });
});
