import { AI_ANSWERING_PLAN, PILOT, monthlyFeePence } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  billingPeriodEndingOn,
  billingPeriodFor,
  chargeFor,
  endedPeriods,
  formatPence,
  ukDateOf,
} from "./billing.ts";

const plan = AI_ANSWERING_PLAN;
const at = (iso: string) => new Date(iso);

describe("billingPeriodFor: months on the go-live anniversary", () => {
  it("runs from the 14th to the 13th, and counts months from going live", () => {
    expect(billingPeriodFor("2026-06-14", at("2026-06-14T08:00:00Z"))).toEqual({
      periodStart: "2026-06-14",
      periodEnd: "2026-07-14",
      index: 0,
    });
    expect(billingPeriodFor("2026-06-14", at("2026-07-13T22:59:00Z"))).toMatchObject({
      periodStart: "2026-06-14",
      index: 0,
    });
    expect(billingPeriodFor("2026-06-14", at("2026-07-13T23:30:00Z"))).toEqual({
      periodStart: "2026-07-14", // 00:30 on the 14th, UK time
      periodEnd: "2026-08-14",
      index: 1,
    });
    expect(billingPeriodFor("2026-06-14", at("2026-12-20T12:00:00Z")).index).toBe(6);
  });

  it("falls back to the last day of shorter months for a 31st anchor, and recovers", () => {
    expect(billingPeriodFor("2026-01-31", at("2026-02-15T12:00:00Z"))).toEqual({
      periodStart: "2026-01-31",
      periodEnd: "2026-02-28",
      index: 0,
    });
    expect(billingPeriodFor("2026-01-31", at("2026-02-28T12:00:00Z"))).toEqual({
      periodStart: "2026-02-28",
      periodEnd: "2026-03-31",
      index: 1,
    });
    expect(billingPeriodFor("2026-01-31", at("2026-04-30T12:00:00Z"))).toEqual({
      periodStart: "2026-04-30",
      periodEnd: "2026-05-31",
      index: 3,
    });
  });

  it("refuses a time before the business went live", () => {
    expect(() => billingPeriodFor("2026-06-14", at("2026-06-13T12:00:00Z"))).toThrow(
      /before the billing start date/,
    );
  });
});

describe("billingPeriodEndingOn", () => {
  it("finds the period that ended that day, or nothing", () => {
    expect(billingPeriodEndingOn("2026-06-14", "2026-08-14")).toEqual({
      periodStart: "2026-07-14",
      periodEnd: "2026-08-14",
      index: 1,
    });
    expect(billingPeriodEndingOn("2026-06-14", "2026-08-13")).toBeNull();
    expect(billingPeriodEndingOn("2026-06-14", "2026-06-14")).toBeNull();
    expect(billingPeriodEndingOn("2026-01-31", "2026-02-28")).toEqual({
      periodStart: "2026-01-31",
      periodEnd: "2026-02-28",
      index: 0,
    });
  });
});

describe("the plan's fee and the pilot's shape (Appendix D)", () => {
  it("is £99 every month on the plan", () => {
    expect(monthlyFeePence(plan, 0, false)).toBe(9900);
    expect(monthlyFeePence(plan, 11, false)).toBe(9900);
  });

  it("is free for the first month, £49 for three, then £99 on the pilot", () => {
    expect(monthlyFeePence(plan, 0, true)).toBe(0);
    expect(monthlyFeePence(plan, 1, true)).toBe(4900);
    expect(monthlyFeePence(plan, 3, true)).toBe(4900);
    expect(monthlyFeePence(plan, 4, true)).toBe(9900);
    expect(PILOT.freeMonths + PILOT.reducedMonths).toBe(4);
  });
});

describe("chargeFor", () => {
  const period = { periodStart: "2026-07-14", periodEnd: "2026-08-14", index: 1 };

  it("charges the fee alone inside the included minutes, with no VAT until registered", () => {
    const charge = chargeFor({
      plan,
      period,
      isPilot: false,
      billableSeconds: 200 * 60,
      vat: null,
    });
    expect(charge).toMatchObject({
      feePence: 9900,
      overageMinutes: 0,
      overagePence: 0,
      subtotalPence: 9900,
      vatRatePercent: 0,
      vatPence: 0,
      totalPence: 9900,
    });
    expect(charge.lines).toEqual([{ description: "AI Answering plan", pence: 9900 }]);
  });

  it("charges one minute's overage at one second over, rounded once for the period", () => {
    const charge = chargeFor({
      plan,
      period,
      isPilot: false,
      billableSeconds: 200 * 60 + 1,
      vat: null,
    });
    expect(charge).toMatchObject({ overageMinutes: 1, overagePence: 20, totalPence: 9920 });
    expect(charge.lines[1]).toEqual({
      description: "1 minute over the 200 included, at 20p a minute",
      pence: 20,
    });
  });

  it("doesn't bill a 4.9-second call's worth: billable seconds are whole, and under 5 is zero", () => {
    // billableSeconds() (usage.ts) turns 4.9 into 0 before it ever reaches here.
    const charge = chargeFor({ plan, period, isPilot: false, billableSeconds: 0, vat: null });
    expect(charge.totalPence).toBe(9900);
    expect(() =>
      chargeFor({ plan, period, isPilot: false, billableSeconds: 4.9, vat: null }),
    ).toThrow(/whole/);
  });

  it("adds 20% VAT from the registration's date, rounded once on the subtotal", () => {
    const vat = { number: "GB123456789", from: "2026-07-01" };
    const charge = chargeFor({ plan, period, isPilot: false, billableSeconds: 200 * 60 + 61, vat });
    // 9900 + 2 minutes at 20p = 9940; 20% = 1988
    expect(charge).toMatchObject({
      subtotalPence: 9940,
      vatRatePercent: 20,
      vatPence: 1988,
      totalPence: 11928,
    });
    // A period that began before the registration date is still VAT-free.
    const before = chargeFor({
      plan,
      period: { ...period, periodStart: "2026-06-14" },
      isPilot: false,
      billableSeconds: 0,
      vat,
    });
    expect(before.vatPence).toBe(0);
  });

  it("waives the pilot's fee, not its overage", () => {
    const first = { periodStart: "2026-06-14", periodEnd: "2026-07-14", index: 0 };
    const charge = chargeFor({
      plan,
      period: first,
      isPilot: true,
      billableSeconds: 201 * 60,
      vat: null,
    });
    expect(charge).toMatchObject({ feePence: 0, overagePence: 20, totalPence: 20 });
    expect(charge.lines[0]).toEqual({ description: "AI Answering plan, pilot month 1", pence: 0 });
  });

  it("stays in integer pence", () => {
    const charge = chargeFor({
      plan,
      period,
      isPilot: false,
      billableSeconds: 12_345,
      vat: { number: "GB1", from: "2026-01-01" },
    });
    for (const value of [
      charge.feePence,
      charge.overagePence,
      charge.vatPence,
      charge.totalPence,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("endedPeriods: what the morning run charges", () => {
  it("lists every month that has ended, oldest first, and none still running", () => {
    expect(endedPeriods("2026-06-14", "2026-08-14", null)).toEqual([
      { periodStart: "2026-06-14", periodEnd: "2026-07-14", index: 0 },
      { periodStart: "2026-07-14", periodEnd: "2026-08-14", index: 1 },
    ]);
    expect(endedPeriods("2026-06-14", "2026-08-13", null)).toHaveLength(1);
    expect(endedPeriods("2026-06-14", "2026-06-20", null)).toEqual([]);
  });

  it("charges a business that left for each month it began before leaving, and none after", () => {
    // Left on 20 July: June's month and July's (which it left in) are charged; August's isn't.
    expect(
      endedPeriods("2026-06-14", "2026-10-01", "2026-07-20").map((p) => p.periodStart),
    ).toEqual(["2026-06-14", "2026-07-14"]);
    // Left on the first day of a month: that month isn't charged.
    expect(
      endedPeriods("2026-06-14", "2026-10-01", "2026-07-14").map((p) => p.periodStart),
    ).toEqual(["2026-06-14"]);
  });

  it("agrees with billingPeriodFor around a 31st anchor", () => {
    const periods = endedPeriods("2026-01-31", "2026-05-31", null);
    expect(periods.map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ["2026-01-31", "2026-02-28"],
      ["2026-02-28", "2026-03-31"],
      ["2026-03-31", "2026-04-30"],
      ["2026-04-30", "2026-05-31"],
    ]);
    for (const period of periods) {
      expect(billingPeriodFor("2026-01-31", new Date(`${period.periodStart}T12:00:00Z`))).toEqual(
        period,
      );
    }
  });
});

describe("ukDateOf", () => {
  it("is the UK date, which runs an hour ahead of UTC in summer", () => {
    expect(ukDateOf(new Date("2026-07-13T23:30:00Z"))).toBe("2026-07-14");
    expect(ukDateOf(new Date("2026-11-13T23:30:00Z"))).toBe("2026-11-13");
  });
});

describe("formatPence", () => {
  it("prints pounds and pence", () => {
    expect(formatPence(9900)).toBe("£99.00");
    expect(formatPence(20)).toBe("£0.20");
    expect(formatPence(11928)).toBe("£119.28");
    expect(formatPence(-5)).toBe("-£0.05");
  });
});
