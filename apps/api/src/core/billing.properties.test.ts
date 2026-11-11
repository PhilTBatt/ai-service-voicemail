// Exhaustive, table-driven checks of the billing maths (decision 019): every anchor day over
// years of months, every day a call could fall on, and thousands of charges. Where it matters
// the expected answer is worked out a second, independent way (integer or BigInt arithmetic,
// the platform's own Intl time zones) rather than by calling the code under test again.
// Thousands of checks each go through one assertion at the end (Checks), which keeps the file
// fast and still names every case that didn't hold.
import { isDeepStrictEqual } from "node:util";
import {
  AI_ANSWERING_PLAN,
  PILOT,
  VAT_RATE_PERCENT,
  monthlyFeePence,
  type Plan,
} from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  billingPeriodEndingOn,
  billingPeriodFor,
  chargeFor,
  endedPeriods,
  formatPence,
  ukDateOf,
  type BillingPeriod,
  type VatRegistration,
} from "./billing.ts";
import {
  MIN_BILLABLE_SECONDS,
  billableSeconds,
  overagePence,
  startOfUkDate,
  usagePeriodFor,
} from "./usage.ts";

const plan = AI_ANSWERING_PLAN;
const day = (date: string) => Temporal.PlainDate.from(date);
/** The largest value a Postgres integer column (billing_charges' pence) holds. */
const PG_INTEGER_MAX = 2_147_483_647;

/** Every date from `from` up to, not including, `to`. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = day(from); Temporal.PlainDate.compare(d, day(to)) < 0; d = d.add({ days: 1 })) {
    dates.push(d.toString());
  }
  return dates;
}

/** Collects what didn't hold; `done()` asserts there was nothing, showing the first few. */
class Checks {
  readonly failures: string[] = [];
  count = 0;

  same(actual: unknown, expected: unknown, label: string): void {
    this.count += 1;
    if (!isDeepStrictEqual(actual, expected)) {
      this.failures.push(
        `${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`,
      );
    }
  }

  that(ok: boolean, label: string): void {
    this.count += 1;
    if (!ok) this.failures.push(label);
  }

  done(atLeast = 1): void {
    expect(this.failures.slice(0, 10)).toEqual([]);
    expect(this.count).toBeGreaterThanOrEqual(atLeast);
  }
}

// An oracle for UK dates that doesn't use Temporal: the platform's Intl time zone data.
const londonDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const londonClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** The last moment of a UK date: a millisecond before the next day's UK midnight. */
const lastMomentOf = (date: string) =>
  new Date(startOfUkDate(day(date).add({ days: 1 }).toString()).getTime() - 1);

/** A small deterministic generator, so "random" cases are the same every run. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return (below: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % below;
  };
}

describe("billing periods for every anchor day over three years", () => {
  // Every day of 2027 and 2028 as a go-live date: all 31 anchor days, months of every length,
  // and a leap February.
  const anchors = datesBetween("2027-01-01", "2029-01-01");
  const threeYears = new Map(
    anchors.map((anchor) => [
      anchor,
      endedPeriods(anchor, day(anchor).add({ years: 3 }).toString(), null),
    ]),
  );

  it("are contiguous, never overlap, never skip a day, and count up from 0", () => {
    const check = new Checks();
    for (const [anchor, periods] of threeYears) {
      check.same(periods.length, 36, `${anchor} count`);
      check.same(periods[0]?.periodStart, anchor, `${anchor} first start`);
      check.same(
        periods.at(-1)?.periodEnd,
        day(anchor).add({ years: 3 }).toString(),
        `${anchor} last end`,
      );
      periods.forEach((period, i) => {
        check.same(period.index, i, `${anchor} #${i} index`);
        const length = day(period.periodStart).until(day(period.periodEnd)).days;
        check.that(length >= 28 && length <= 31, `${anchor} #${i} is ${length} days`);
        const next = periods[i + 1];
        if (next) check.same(next.periodStart, period.periodEnd, `${anchor} #${i} joins the next`);
      });
    }
    check.done(anchors.length * 36);
  });

  it("start on the anchor's day of the month, or the month's last day when it's shorter", () => {
    const check = new Checks();
    for (const [anchor, periods] of threeYears) {
      const a = day(anchor);
      for (const period of periods) {
        const start = day(period.periodStart);
        check.same(
          start.day,
          Math.min(a.day, start.daysInMonth),
          `${anchor} ${period.periodStart}`,
        );
        // Exactly one calendar month on from the anchor per period: no drift after February.
        const months = (start.year - a.year) * 12 + start.month - a.month;
        check.same(months, period.index, `${anchor} ${period.periodStart} months on`);
      }
    }
    check.done(anchors.length * 36);
  });

  it("are twelve a year, so a business pays twelve times a year, not thirteen", () => {
    const check = new Checks();
    for (const anchor of anchors) {
      const yearOn = day(anchor).add({ years: 1 });
      check.same(endedPeriods(anchor, yearOn.toString(), null).length, 12, anchor);
      // A day short of the year: the twelfth hasn't ended.
      check.same(
        endedPeriods(anchor, yearOn.subtract({ days: 1 }).toString(), null).length,
        11,
        `${anchor} a day short`,
      );
    }
    check.done(anchors.length * 2);
  });

  it("are each found again by billingPeriodEndingOn on the day they end", () => {
    const check = new Checks();
    for (const [anchor, periods] of threeYears) {
      for (const period of periods) {
        check.same(billingPeriodEndingOn(anchor, period.periodEnd), period, anchor);
      }
    }
    check.done(anchors.length * 36);
  });

  it("hold their first and last moments, UK time, whatever the clocks did", () => {
    // The anchor days where months differ: the 1st, and the 28th to the 31st.
    const check = new Checks();
    for (const [anchor, periods] of threeYears) {
      if (![1, 28, 29, 30, 31].includes(day(anchor).day)) continue;
      for (const period of periods) {
        const lastDay = day(period.periodEnd).subtract({ days: 1 }).toString();
        check.same(billingPeriodFor(anchor, startOfUkDate(period.periodStart)), period, anchor);
        check.same(billingPeriodFor(anchor, lastMomentOf(lastDay)), period, `${anchor} last`);
      }
    }
    check.done(100 * 36);
  });
});

describe("every day of two years, for anchors on the days months differ", () => {
  // The ends of January 2028 run through a leap February; 29 February 2028 itself; the ends of
  // January 2027 through an ordinary one; and the 1st and 15th for contrast.
  const anchors = [
    "2028-01-01",
    "2028-01-15",
    "2028-01-28",
    "2028-01-29",
    "2028-01-30",
    "2028-01-31",
    "2028-02-29",
    "2027-01-29",
    "2027-01-30",
    "2027-01-31",
  ];

  it("puts each day, first moment to last, in exactly one period, the same one usage uses", () => {
    const check = new Checks();
    for (const anchor of anchors) {
      const periods = endedPeriods(anchor, day(anchor).add({ years: 2 }).toString(), null);
      let expected = 0;
      for (const date of datesBetween(anchor, periods.at(-1)!.periodEnd)) {
        if (date === periods[expected + 1]?.periodStart) expected += 1;
        const period = periods[expected]!;
        const label = `${anchor} ${date}`;
        check.same(billingPeriodFor(anchor, startOfUkDate(date)), period, `${label} 00:00`);
        check.same(billingPeriodFor(anchor, lastMomentOf(date)), period, `${label} 23:59`);
        // Usage is recorded against the same months the charge reads (db/calls.ts).
        check.same(
          usagePeriodFor(lastMomentOf(date), anchor),
          { periodStart: period.periodStart, periodEnd: period.periodEnd },
          `${label} usage`,
        );
        // Only a period's first day is the day another period ended on.
        check.same(
          billingPeriodEndingOn(anchor, date),
          date === period.periodStart && period.index > 0 ? periods[expected - 1] : null,
          `${label} ending`,
        );
      }
    }
    check.done(anchors.length * 700 * 4);
  });

  it("never finds a period for a moment before going live", () => {
    for (const anchor of anchors) {
      expect(() => billingPeriodFor(anchor, new Date(startOfUkDate(anchor).getTime() - 1))).toThrow(
        /before the billing start date/,
      );
      expect(billingPeriodEndingOn(anchor, anchor)).toBeNull();
      expect(
        billingPeriodEndingOn(anchor, day(anchor).subtract({ days: 40 }).toString()),
      ).toBeNull();
      expect(endedPeriods(anchor, day(anchor).subtract({ days: 1 }).toString(), null)).toEqual([]);
    }
  });
});

describe("period boundaries on the days the clocks change", () => {
  // UK midnight on the day the clocks go forward is 00:00 GMT; on the day they go back it's
  // still BST, so 23:00 UTC the evening before.
  const cases: { anchor: string; boundary: string; utc: string }[] = [
    { anchor: "2026-01-29", boundary: "2026-03-29", utc: "2026-03-29T00:00:00.000Z" },
    { anchor: "2026-09-25", boundary: "2026-10-25", utc: "2026-10-24T23:00:00.000Z" },
    { anchor: "2027-01-28", boundary: "2027-03-28", utc: "2027-03-28T00:00:00.000Z" },
    { anchor: "2027-01-31", boundary: "2027-10-31", utc: "2027-10-30T23:00:00.000Z" },
    { anchor: "2028-02-26", boundary: "2028-03-26", utc: "2028-03-26T00:00:00.000Z" },
    { anchor: "2028-09-29", boundary: "2028-10-29", utc: "2028-10-28T23:00:00.000Z" },
  ];

  it.each(cases)(
    "$anchor: the period starting $boundary begins at $utc",
    ({ anchor, boundary, utc }) => {
      expect(startOfUkDate(boundary).toISOString()).toBe(utc);
      const at = new Date(utc);
      const before = new Date(at.getTime() - 1);
      expect(billingPeriodFor(anchor, at).periodStart).toBe(boundary);
      expect(billingPeriodFor(anchor, before).periodEnd).toBe(boundary);
      expect(billingPeriodFor(anchor, at).index).toBe(billingPeriodFor(anchor, before).index + 1);
      expect(ukDateOf(at)).toBe(boundary);
      expect(ukDateOf(before)).toBe(day(boundary).subtract({ days: 1 }).toString());
    },
  );
});

describe("UK dates against the platform's own time zone data", () => {
  it("ukDateOf and startOfUkDate agree with Intl for every day of 2026 to 2028", () => {
    const check = new Checks();
    for (const date of datesBetween("2026-01-01", "2029-01-01")) {
      const start = startOfUkDate(date);
      check.same(londonDate.format(start), date, `${date} starts that day`);
      check.same(londonClock.format(start), "00:00:00", `${date} starts at midnight`);
      check.that(londonDate.format(new Date(start.getTime() - 1)) !== date, `${date} a ms before`);
      check.same(ukDateOf(start), date, `${date} ukDateOf start`);
      check.same(ukDateOf(lastMomentOf(date)), date, `${date} ukDateOf end`);
    }
    check.done(1096 * 5);
  });

  it("ukDateOf agrees with Intl every quarter hour across both clock changes of 2026", () => {
    const check = new Checks();
    for (const [from, to] of [
      ["2026-03-28T20:00:00Z", "2026-03-29T04:00:00Z"],
      ["2026-10-24T20:00:00Z", "2026-10-25T04:00:00Z"],
    ] as const) {
      for (let t = Date.parse(from); t <= Date.parse(to); t += 15 * 60_000) {
        check.same(ukDateOf(new Date(t)), londonDate.format(t), new Date(t).toISOString());
      }
    }
    check.done(60);
  });
});

describe("endedPeriods as the days go by", () => {
  const anchor = "2027-01-31";
  const all = endedPeriods(anchor, "2030-01-31", null);

  it("only ever adds the month that just ended, and never charges one still running", () => {
    const check = new Checks();
    let previous: BillingPeriod[] = [];
    for (const today of datesBetween("2027-01-01", "2029-03-01")) {
      const ended = endedPeriods(anchor, today, null);
      // Everything charged yesterday is still in the list, in the same order.
      check.same(ended.slice(0, previous.length), previous, `${today} keeps yesterday's`);
      check.that(ended.length - previous.length <= 1, `${today} adds at most one`);
      check.same(
        ended,
        all.filter((p) => p.periodEnd <= today),
        `${today} only ended ones`,
      );
      previous = ended;
    }
    check.done(790 * 3);
  });

  it("charges a business that left for every month that began before that day, and none after", () => {
    const check = new Checks();
    const anchors = ["2027-01-31", "2027-02-28", "2027-03-14", "2028-02-29", "2027-06-01"];
    for (const a of anchors) {
      const every = endedPeriods(a, "2031-01-01", null);
      for (const leftOn of datesBetween(day(a).subtract({ days: 3 }).toString(), "2029-01-01")) {
        const charged = endedPeriods(a, "2031-01-01", leftOn);
        const label = `${a} left ${leftOn}`;
        check.same(
          charged,
          every.filter((p) => p.periodStart < leftOn),
          label,
        );
        if (leftOn <= a) {
          check.same(charged, [], `${label} before going live`);
        } else {
          // The last one charged is the month it asked to leave in, or, asking on the first
          // day of a month, the month before: the one holding the day before it asked.
          const last = charged.at(-1)!;
          const dayBefore = day(leftOn).subtract({ days: 1 }).toString();
          check.that(last.periodStart <= dayBefore && dayBefore < last.periodEnd, label);
        }
      }
    }
    check.done(2_000);
  });
});

describe("chargeFor across thousands of cases", () => {
  const vatFrom: VatRegistration = { number: "GB000000000", from: "2027-04-01" };
  // The edges of a minute, of the included minutes, and of the minimum; a month of calls
  // around the clock on one line and on ten; and a spread of ordinary months.
  const seconds = [0, 1, 4, 5, 59, 60, 61, 119, 120, 121, 11_940, 11_941, 11_999, 12_000];
  seconds.push(12_001, 12_059, 12_060, 12_061, 12_120, 12_121, 3_600 * 24 * 31);
  seconds.push(10 * 3_600 * 24 * 31);
  const random = lcg(19);
  for (let i = 0; i < 200; i++) seconds.push(random(40_000));
  const periodsFor = (anchor: string) => endedPeriods(anchor, "2028-06-01", null).slice(0, 8);
  const periods = [...periodsFor("2027-01-31"), ...periodsFor("2027-03-01")];

  /** The same sums, worked out in BigInt so a floating-point slip in the code can't hide. */
  function expected(
    period: BillingPeriod,
    isPilot: boolean,
    billable: number,
    vat: VatRegistration | null,
  ) {
    const fee = BigInt(monthlyFeePence(plan, period.index, isPilot));
    const minutes = (BigInt(billable) + 59n) / 60n;
    const included = BigInt(plan.includedMinutes);
    const overMinutes = minutes > included ? minutes - included : 0n;
    const overage = overMinutes * BigInt(plan.overagePencePerMinute);
    const subtotal = fee + overage;
    const rate = vat !== null && period.periodStart >= vat.from ? BigInt(VAT_RATE_PERCENT) : 0n;
    // Half up, on the subtotal, once.
    const vatPence = (subtotal * rate * 2n + 100n) / 200n;
    return {
      feePence: Number(fee),
      overageMinutes: Number(overMinutes),
      overagePence: Number(overage),
      subtotalPence: Number(subtotal),
      vatRatePercent: Number(rate),
      vatPence: Number(vatPence),
      totalPence: Number(subtotal + vatPence),
    };
  }

  it("matches integer arithmetic exactly, and its parts always add up", () => {
    const check = new Checks();
    for (const period of periods) {
      for (const isPilot of [false, true]) {
        for (const vat of [null, vatFrom]) {
          for (const billable of seconds) {
            const { lines, ...charge } = chargeFor({
              plan,
              period,
              isPilot,
              billableSeconds: billable,
              vat,
            });
            const label = `${period.periodStart} pilot=${isPilot} vat=${vat !== null} s=${billable}`;
            check.same(charge, expected(period, isPilot, billable, vat), label);
            const parts = [...Object.values(charge), ...lines.map((line) => line.pence)];
            check.that(
              parts.every((value) => Number.isSafeInteger(value) && value >= 0),
              `${label} whole pence`,
            );
            check.same(charge.subtotalPence, charge.feePence + charge.overagePence, label);
            check.same(charge.totalPence, charge.subtotalPence + charge.vatPence, label);
            // The receipt's lines are the subtotal, ex VAT: nothing shown that isn't charged.
            check.same(
              lines.reduce((sum, line) => sum + line.pence, 0),
              charge.subtotalPence,
              `${label} lines`,
            );
            check.same(lines.length, charge.overageMinutes > 0 ? 2 : 1, `${label} line count`);
            check.same(
              charge.overagePence,
              overagePence(billable, plan.includedMinutes, plan.overagePencePerMinute),
              `${label} overagePence`,
            );
            // The database's integer columns hold it (billing_charges).
            check.that(charge.totalPence <= PG_INTEGER_MAX, `${label} fits`);
          }
        }
      }
    }
    check.done(16 * 2 * 2 * 222 * 7);
  });

  it("never charges less for more seconds", () => {
    const period = periods[3]!;
    let last = -1;
    const check = new Checks();
    for (let s = 11_000; s <= 13_000; s += 1) {
      const total = chargeFor({
        plan,
        period,
        isPilot: false,
        billableSeconds: s,
        vat: vatFrom,
      }).totalPence;
      check.that(total >= last, `${s} s`);
      last = total;
    }
    check.done(2_001);
  });

  it("charges the same for a month's seconds however they were split into calls", () => {
    // Rounding is once for the month, so 3 calls of 61 s and 1 call of 183 s cost the same,
    // and never more than rounding each call up would.
    const random = lcg(7);
    const period = periods[2]!;
    const check = new Checks();
    for (let trial = 0; trial < 300; trial++) {
      const calls = Array.from(
        { length: 1 + random(400) },
        () => MIN_BILLABLE_SECONDS + random(600),
      );
      const total = calls.reduce((sum, s) => sum + s, 0);
      const perCallMinutes = calls.reduce((sum, s) => sum + Math.ceil(s / 60), 0);
      const charge = chargeFor({ plan, period, isPilot: false, billableSeconds: total, vat: null });
      check.same(
        charge.overageMinutes,
        Math.max(0, Math.ceil(total / 60) - plan.includedMinutes),
        `trial ${trial}`,
      );
      check.that(
        charge.overageMinutes <= Math.max(0, perCallMinutes - plan.includedMinutes),
        `trial ${trial} per call`,
      );
    }
    check.done(600);
  });

  it("rounds VAT once on the subtotal, half up, for every subtotal from 0 to £500", () => {
    // A plan whose fee is the subtotal under test and whose minutes are never exceeded.
    const period = { periodStart: "2027-05-01", periodEnd: "2027-06-01", index: 4 };
    const check = new Checks();
    for (let subtotal = 0; subtotal <= 50_000; subtotal++) {
      const custom: Plan = { ...plan, monthlyPence: subtotal, includedMinutes: 1_000_000 };
      const charge = chargeFor({
        plan: custom,
        period,
        isPilot: false,
        billableSeconds: 0,
        vat: vatFrom,
      });
      const vat = Math.floor((subtotal * VAT_RATE_PERCENT * 2 + 100) / 200);
      check.same([charge.vatPence, charge.totalPence], [vat, subtotal + vat], `£${subtotal}p`);
    }
    check.done(50_001);
  });

  it("charges nothing at all for a month suspended throughout, whatever else is true", () => {
    const check = new Checks();
    for (const period of periods) {
      for (const isPilot of [false, true]) {
        for (const billable of seconds) {
          const charge = chargeFor({
            plan,
            period,
            isPilot,
            billableSeconds: billable,
            vat: vatFrom,
            suspendedThroughout: true,
          });
          check.same(
            charge,
            {
              feePence: 0,
              overageMinutes: 0,
              overagePence: 0,
              subtotalPence: 0,
              vatRatePercent: 0,
              vatPence: 0,
              totalPence: 0,
              lines: [{ description: "Suspended for the whole month: no charge", pence: 0 }],
            },
            `${period.periodStart} ${isPilot} ${billable}`,
          );
        }
      }
    }
    check.done(16 * 2 * 222);
  });

  it("refuses seconds that aren't a whole, non-negative, finite number", () => {
    const period = periods[0]!;
    for (const bad of [-1, -0.5, 0.5, 4.9, 12_000.0001, Number.NaN, Infinity, -Infinity]) {
      expect(
        () => chargeFor({ plan, period, isPilot: false, billableSeconds: bad, vat: null }),
        String(bad),
      ).toThrow(/whole, non-negative/);
    }
  });

  it("starts VAT with the first period that begins on or after the registration date", () => {
    const check = new Checks();
    for (const period of endedPeriods("2027-01-31", "2028-01-31", null)) {
      for (const from of [
        day(period.periodStart).subtract({ days: 1 }).toString(),
        period.periodStart,
        day(period.periodStart).add({ days: 1 }).toString(),
      ]) {
        const charge = chargeFor({
          plan,
          period,
          isPilot: false,
          billableSeconds: 0,
          vat: { number: "GB1", from },
        });
        const on = from <= period.periodStart;
        check.same(
          [charge.vatRatePercent, charge.vatPence, charge.totalPence],
          on ? [VAT_RATE_PERCENT, 1980, 11_880] : [0, 0, 9900],
          `${period.periodStart} from ${from}`,
        );
      }
    }
    check.done(36);
  });
});

describe("the pilot's shape and the plan's fee, month by month", () => {
  it("is free, then the reduced fee, then the plan's, and the plan's every month off the pilot", () => {
    const pilot = Array.from({ length: 24 }, (_, i) => monthlyFeePence(plan, i, true));
    expect(pilot).toEqual([
      ...Array<number>(PILOT.freeMonths).fill(0),
      ...Array<number>(PILOT.reducedMonths).fill(PILOT.reducedMonthlyPence),
      ...Array<number>(24 - PILOT.freeMonths - PILOT.reducedMonths).fill(plan.monthlyPence),
    ]);
    // A pilot's first year: £0 + 3 × £49 + 8 × £99.
    expect(pilot.slice(0, 12).reduce((sum, fee) => sum + fee, 0)).toBe(93_900);
    for (let i = 0; i < 120; i++) expect(monthlyFeePence(plan, i, false)).toBe(9900);
  });

  it("labels each pilot month on the receipt, and only those billed below the plan's fee", () => {
    for (const period of endedPeriods("2027-01-31", "2028-01-31", null)) {
      const [line] = chargeFor({
        plan,
        period,
        isPilot: true,
        billableSeconds: 0,
        vat: null,
      }).lines;
      expect(line?.description).toBe(
        period.index < PILOT.freeMonths + PILOT.reducedMonths
          ? `AI Answering plan, pilot month ${period.index + 1}`
          : "AI Answering plan",
      );
    }
  });
});

describe("billableSeconds and overagePence", () => {
  it("bills whole seconds from 5, nothing under, and never more than the call lasted", () => {
    const check = new Checks();
    for (let tenths = 0; tenths <= 2_000; tenths++) {
      const duration = tenths / 10;
      const billable = billableSeconds(duration);
      check.same(
        billable,
        duration < MIN_BILLABLE_SECONDS ? 0 : Math.floor(duration),
        String(duration),
      );
      check.that(Number.isInteger(billable) && billable <= duration, `${duration} whole`);
    }
    check.done(4_002);
    expect(billableSeconds(-30)).toBe(0);
  });

  it("is zero up to the included minutes, then the rate for every started minute", () => {
    const check = new Checks();
    for (let s = 0; s <= 13_000; s++) {
      const minutesOver = Math.max(0, Math.floor((s + 59) / 60) - 200);
      check.same(overagePence(s, 200, 20), minutesOver * 20, `${s} s`);
    }
    check.done(13_001);
  });
});

describe("usagePeriodFor without a billing start date: the UK calendar month", () => {
  it("agrees with Intl every hour of two years", () => {
    const check = new Checks();
    const hour = 3_600_000;
    for (
      let t = Date.parse("2026-01-01T00:00:00Z");
      t < Date.parse("2028-01-01T00:00:00Z");
      t += hour
    ) {
      const [year, month] = londonDate.format(t).split("-");
      const start = `${year!}-${month!}-01`;
      check.same(
        usagePeriodFor(new Date(t)),
        { periodStart: start, periodEnd: day(start).add({ months: 1 }).toString() },
        new Date(t).toISOString(),
      );
    }
    check.done(17_000);
  });
});

describe("formatPence", () => {
  it("prints every amount from -£200 to £200 so that it reads back to the same pence", () => {
    const check = new Checks();
    for (let pence = -20_000; pence <= 20_000; pence++) {
      const match = /^(-?)£(\d+)\.(\d{2})$/.exec(formatPence(pence));
      check.same(
        match && (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 100 + Number(match[3])),
        pence,
        `${pence} as ${formatPence(pence)}`,
      );
    }
    check.done(40_001);
    expect(formatPence(0)).toBe("£0.00");
    expect(formatPence(PG_INTEGER_MAX)).toBe("£21474836.47");
  });
});
