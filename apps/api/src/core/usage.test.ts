import { describe, expect, it } from "vitest";
import { billableSeconds, overagePence, startOfUkDate, usagePeriodFor } from "./usage.ts";

describe("billableSeconds", () => {
  it("doesn't bill calls under 5 seconds", () => {
    expect(billableSeconds(4.9)).toBe(0);
    expect(billableSeconds(0)).toBe(0);
  });

  it("bills from 5 seconds, in whole seconds", () => {
    expect(billableSeconds(5)).toBe(5);
    expect(billableSeconds(90.7)).toBe(90);
    // The line is exactly at 5 seconds, and a negative duration (clocks disagreeing) is nothing.
    expect(billableSeconds(4.999)).toBe(0);
    expect(billableSeconds(5.999)).toBe(5);
    expect(billableSeconds(-12)).toBe(0);
  });
});

describe("usagePeriodFor", () => {
  it("uses the UK calendar month", () => {
    expect(usagePeriodFor(new Date("2026-07-15T10:00:00Z"))).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-08-01",
    });
  });

  it("puts a call at 23:30 UTC on 31 July into August, because it's August in UK time", () => {
    expect(usagePeriodFor(new Date("2026-07-31T23:30:00Z"))).toEqual({
      periodStart: "2026-08-01",
      periodEnd: "2026-09-01",
    });
  });

  it("keeps a winter midnight call in the right month", () => {
    expect(usagePeriodFor(new Date("2026-11-30T23:30:00Z"))).toEqual({
      periodStart: "2026-11-01",
      periodEnd: "2026-12-01",
    });
  });

  // Decision 019: a live business's periods are months from the day it went live.
  it("uses months from the billing start date once a business has one", () => {
    expect(usagePeriodFor(new Date("2026-07-15T10:00:00Z"), "2026-06-14")).toEqual({
      periodStart: "2026-07-14",
      periodEnd: "2026-08-14",
    });
    // 23:30 UTC on 13 August is 00:30 on the 14th in the UK: the next period.
    expect(usagePeriodFor(new Date("2026-08-13T23:30:00Z"), "2026-06-14")).toEqual({
      periodStart: "2026-08-14",
      periodEnd: "2026-09-14",
    });
    // A 31st anchor: February's period ends on the 28th, and the next runs to 31 March.
    expect(usagePeriodFor(new Date("2026-03-10T12:00:00Z"), "2026-01-31")).toEqual({
      periodStart: "2026-02-28",
      periodEnd: "2026-03-31",
    });
  });

  it("falls back to the calendar month for a call from before the business went live", () => {
    expect(usagePeriodFor(new Date("2026-06-10T10:00:00Z"), "2026-06-14")).toEqual({
      periodStart: "2026-06-01",
      periodEnd: "2026-07-01",
    });
  });
});

describe("overagePence (200 included minutes, 20p a minute)", () => {
  it("is zero exactly at the included minutes", () => {
    expect(overagePence(200 * 60, 200, 20)).toBe(0);
    // And anywhere inside them, or with none used.
    expect(overagePence(0, 200, 20)).toBe(0);
    expect(overagePence(199 * 60 + 59, 200, 20)).toBe(0);
    expect(overagePence(0, 0, 20)).toBe(0);
    expect(overagePence(1, 0, 20)).toBe(20);
  });

  it("is one minute's overage at one second over", () => {
    expect(overagePence(200 * 60 + 1, 200, 20)).toBe(20);
  });

  it("rounds up once per period, not per call", () => {
    // Ten 61-second calls: per-call rounding would charge 20 minutes; the period total is 610 s = 11 minutes.
    expect(overagePence(10 * 61, 0, 20)).toBe(11 * 20);
  });

  it("stays in integer pence", () => {
    expect(Number.isInteger(overagePence(12345, 200, 20))).toBe(true);
    // 205.75 minutes rounds up once to 206: six over.
    expect(overagePence(12345, 200, 20)).toBe(120);
  });
});

describe("startOfUkDate", () => {
  it("is midnight UTC in winter and 23:00 UTC the day before in summer", () => {
    expect(startOfUkDate("2026-11-01").toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(startOfUkDate("2026-07-01").toISOString()).toBe("2026-06-30T23:00:00.000Z");
    // The clocks change at 01:00 UTC, after midnight: the day they go forward still starts at
    // GMT midnight, and the day they go back at BST midnight.
    expect(startOfUkDate("2026-03-29").toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(startOfUkDate("2026-03-30").toISOString()).toBe("2026-03-29T23:00:00.000Z");
    expect(startOfUkDate("2026-10-25").toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(startOfUkDate("2026-10-26").toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});
