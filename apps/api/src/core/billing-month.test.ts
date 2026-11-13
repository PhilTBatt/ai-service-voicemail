// The Account page's month so far (core/billing.ts): how far through the month it is, where
// the minutes are heading, and each day's minutes adding up to what's billed.
import { describe, expect, it } from "vitest";
import {
  PROJECTION_FROM_DAY,
  currentBillingPeriod,
  daysOfMonth,
  monthProgress,
  projectedSeconds,
} from "./billing.ts";

const november = { periodStart: "2026-11-14", periodEnd: "2026-12-14" };

describe("monthProgress", () => {
  it("counts today as begun, from the month's first day", () => {
    expect(monthProgress(november, "2026-11-14")).toEqual({ days: 30, daysSoFar: 1 });
    expect(monthProgress(november, "2026-11-20")).toEqual({ days: 30, daysSoFar: 7 });
    expect(monthProgress(november, "2026-12-13")).toEqual({ days: 30, daysSoFar: 30 });
  });

  it("stays inside the month for a day before it or after it", () => {
    expect(monthProgress(november, "2026-11-13")).toEqual({ days: 30, daysSoFar: 0 });
    expect(monthProgress(november, "2026-12-25")).toEqual({ days: 30, daysSoFar: 30 });
  });

  it("knows a month's real length: 28 days from 31 January's anchor in February", () => {
    expect(
      monthProgress({ periodStart: "2027-01-31", periodEnd: "2027-02-28" }, "2027-02-01"),
    ).toEqual({ days: 28, daysSoFar: 2 });
    expect(
      monthProgress({ periodStart: "2027-02-28", periodEnd: "2027-03-31" }, "2027-03-30"),
    ).toEqual({ days: 31, daysSoFar: 31 });
  });
});

describe("projectedSeconds", () => {
  it("says nothing in the first days, when one call would swing it", () => {
    for (let day = 0; day < PROJECTION_FROM_DAY; day += 1) {
      expect(projectedSeconds(600, { days: 30, daysSoFar: day })).toBeNull();
    }
  });

  it("carries the rate so far to the month's end", () => {
    expect(projectedSeconds(4321, { days: 30, daysSoFar: 7 })).toBe(18519);
    expect(projectedSeconds(6000, { days: 30, daysSoFar: 15 })).toBe(12000);
    expect(projectedSeconds(0, { days: 30, daysSoFar: 10 })).toBe(0);
  });

  it("is the usage itself on the last day", () => {
    expect(projectedSeconds(9999, { days: 31, daysSoFar: 31 })).toBe(9999);
  });
});

describe("daysOfMonth", () => {
  it("lists every day from the first to today, with nothing on days without calls", () => {
    const stored = new Map([
      ["2026-11-14", 300],
      ["2026-11-16", 90],
    ]);
    expect(daysOfMonth("2026-11-14", "2026-11-17", stored, 390)).toEqual([
      { date: "2026-11-14", billableSeconds: 300 },
      { date: "2026-11-15", billableSeconds: 0 },
      { date: "2026-11-16", billableSeconds: 90 },
      { date: "2026-11-17", billableSeconds: 0 },
    ]);
  });

  it("takes calls that weren't billed off the earliest days, so the days add up to the bill", () => {
    const stored = new Map([
      ["2026-11-14", 100],
      ["2026-11-15", 200],
    ]);
    // 150 seconds stored but not billed: all of the 14th's 100, then 50 of the 15th's.
    expect(daysOfMonth("2026-11-14", "2026-11-15", stored, 150)).toEqual([
      { date: "2026-11-14", billableSeconds: 0 },
      { date: "2026-11-15", billableSeconds: 150 },
    ]);
  });

  it("is empty before the month starts", () => {
    expect(daysOfMonth("2026-11-14", "2026-11-13", new Map(), 0)).toEqual([]);
  });
});

describe("currentBillingPeriod", () => {
  it("is the first month when this server's clock is a moment behind on go-live day", () => {
    expect(currentBillingPeriod("2026-11-11", new Date("2026-11-10T23:59:59.900Z"))).toEqual({
      periodStart: "2026-11-11",
      periodEnd: "2026-12-11",
      index: 0,
    });
  });

  it("is the month containing now otherwise", () => {
    expect(currentBillingPeriod("2026-09-14", new Date("2026-11-20T12:00:00Z"))).toMatchObject({
      periodStart: "2026-11-14",
      index: 2,
    });
  });
});
