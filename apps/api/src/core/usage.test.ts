import { describe, expect, it } from "vitest";
import { billableSeconds, overagePence, usagePeriodFor } from "./usage.ts";

describe("billableSeconds", () => {
  it("doesn't bill calls under 5 seconds", () => {
    expect(billableSeconds(4.9)).toBe(0);
    expect(billableSeconds(0)).toBe(0);
  });

  it("bills from 5 seconds, in whole seconds", () => {
    expect(billableSeconds(5)).toBe(5);
    expect(billableSeconds(90.7)).toBe(90);
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
});

describe("overagePence (200 included minutes, 20p a minute)", () => {
  it("is zero exactly at the included minutes", () => {
    expect(overagePence(200 * 60, 200, 20)).toBe(0);
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
  });
});
