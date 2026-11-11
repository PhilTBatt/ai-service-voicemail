// Money and dates as people read them, checked exhaustively: suppliers' prices to whole pence
// (against BigInt arithmetic), every date of three years on receipts (against the platform's
// own UTC date arithmetic), receipts whose lines always add up to the total they state, and
// CSV that reads back to exactly what was written.
import { AI_ANSWERING_PLAN } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { chargeFor, endedPeriods, formatPence } from "./billing.ts";
import {
  billingSituation,
  formatDate,
  lastDayOf,
  paymentFailedEmail,
  receiptEmail,
} from "./billing-emails.ts";
import { toCsv } from "./csv.ts";
import { poundsToPence } from "./prices.ts";

/** Pounds as a decimal string to pence, rounded half up, in BigInt: the oracle. */
function oraclePence(amount: string): number {
  const [whole, fraction = ""] = amount.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const scaled = BigInt(whole! + fraction);
  return Number((scaled * 200n + scale) / (2n * scale));
}

describe("poundsToPence", () => {
  it("matches BigInt rounding for every amount to a tenth of a penny up to £20", () => {
    const wrong: string[] = [];
    for (let pounds = 0; pounds <= 20; pounds++) {
      for (let mills = 0; mills < 1000; mills++) {
        const amount = `${pounds}.${String(mills).padStart(3, "0")}`;
        if (poundsToPence(amount) !== oraclePence(amount)) wrong.push(amount);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("matches BigInt rounding for long supplier prices, and short ones", () => {
    const amounts = ["0", "7", "0.1", "0.05", "0.004", "0.005", "0.0049999", "0.0050001"];
    amounts.push("0.86917", "0.007558", "0.042325", "0.99999999", "19.995", "123456.789");
    let seed = 11;
    for (let i = 0; i < 2_000; i++) {
      seed = (seed * 48_271) % 2_147_483_647;
      const digits = String(seed).padStart(10, "0");
      amounts.push(`${digits.slice(0, 2)}.${digits.slice(2, 3 + (seed % 7))}`);
    }
    for (const amount of amounts) {
      expect(poundsToPence(amount), amount).toBe(oraclePence(amount));
    }
  });

  it("refuses what isn't a plain amount of pounds", () => {
    for (const bad of [
      "",
      ".5",
      "1.",
      "1,000.00",
      "1e3",
      "0x10",
      "-0.01",
      "+1",
      "£1",
      "1.2.3",
      "NaN",
    ]) {
      expect(() => poundsToPence(bad), JSON.stringify(bad)).toThrow("Not an amount of money");
    }
  });
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

describe("dates on receipts", () => {
  /** Every date of 2026 to 2028, from UTC calendar arithmetic rather than Temporal. */
  const dates: string[] = [];
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2029, 0, 1); t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }

  it("writes every date of three years as people do", () => {
    const wrong = dates.filter((date) => {
      const [y, m, d] = date.split("-").map(Number);
      return formatDate(date) !== `${d!} ${MONTHS[m! - 1]!} ${y!}`;
    });
    expect(wrong).toEqual([]);
    expect(dates).toHaveLength(1096);
  });

  it("finds the last day of a period ending on every date of three years", () => {
    const wrong = dates.filter((date) => {
      const [y, m, d] = date.split("-").map(Number);
      const dayBefore = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
      return lastDayOf(date) !== dayBefore;
    });
    expect(wrong).toEqual([]);
    expect(lastDayOf("2028-03-01")).toBe("2028-02-29");
    expect(lastDayOf("2027-03-01")).toBe("2027-02-28");
    expect(lastDayOf("2027-01-01")).toBe("2026-12-31");
  });

  it("refuses anything but a plain date", () => {
    for (const bad of ["2026-1-4", "14/10/2026", "", "2026-10-14T00:00:00Z", "20261014"]) {
      expect(() => formatDate(bad), bad).toThrow(/Expected a date/);
    }
  });
});

describe("receipts add up", () => {
  const plan = AI_ANSWERING_PLAN;
  const periods = endedPeriods("2027-01-31", "2028-02-01", null);
  const pounds = (text: string) =>
    [...text.matchAll(/(-?)£(\d+)\.(\d{2})/g)].map(
      ([, sign, p, d]) => (sign === "-" ? -1 : 1) * (Number(p) * 100 + Number(d)),
    );

  it("shows each part and a total that is their sum, for every kind of month", () => {
    let receipts = 0;
    for (const period of periods) {
      for (const isPilot of [false, true]) {
        for (const vat of [null, { number: "GB999999973", from: "2027-06-30" }]) {
          for (const seconds of [0, 200 * 60, 200 * 60 + 1, 333 * 60 + 17]) {
            const charge = chargeFor({ plan, period, isPilot, billableSeconds: seconds, vat });
            const { text, html, subject } = receiptEmail("Fictional Plumbing", {
              periodStart: period.periodStart,
              periodEnd: period.periodEnd,
              lines: charge.lines,
              vatRatePercent: charge.vatRatePercent,
              vatPence: charge.vatPence,
              totalPence: charge.totalPence,
              vatNumber: charge.vatRatePercent > 0 ? "GB999999973" : null,
              chargeDate: charge.totalPence > 0 ? "2027-03-05" : null,
            });
            const amounts = pounds(text);
            const total = amounts.at(-1);
            expect(total).toBe(charge.totalPence);
            expect(amounts.slice(0, -1).reduce((sum, p) => sum + p, 0)).toBe(charge.totalPence);
            expect(text).toContain(`Total: ${formatPence(charge.totalPence)}`);
            expect(text.includes("VAT at 20%")).toBe(charge.vatRatePercent > 0);
            expect(text.includes("VAT registration number: GB999999973")).toBe(
              charge.vatRatePercent > 0,
            );
            // The HTML says the same sums.
            expect(pounds(html)).toEqual(amounts);
            expect(subject).toBe(
              `Your AnswerMate receipt: ${formatDate(period.periodStart)} to ${formatDate(lastDayOf(period.periodEnd))}`,
            );
            receipts += 1;
          }
        }
      }
    }
    expect(receipts).toBe(12 * 2 * 2 * 4);
  });

  it("says when nothing's to pay, and when a payment's date isn't known yet", () => {
    const base = {
      periodStart: "2027-01-31",
      periodEnd: "2027-02-28",
      lines: [{ description: "AI Answering plan, pilot month 1", pence: 0 }],
      vatRatePercent: 0,
      vatPence: 0,
      totalPence: 0,
      vatNumber: null,
      chargeDate: null,
    };
    expect(receiptEmail("Fictional Plumbing", base).text).toContain(
      "There's nothing to pay for this month.",
    );
    const owed = {
      ...base,
      lines: [{ description: "AI Answering plan", pence: 9900 }],
      totalPence: 9900,
    };
    expect(receiptEmail("Fictional Plumbing", owed).text).toContain("in the next few days");
    expect(receiptEmail("Fictional Plumbing", owed).text).toContain(
      "No VAT is charged on this month.",
    );
    // The receipt's period is the 31st of January to the 27th of February: the day before the end.
    expect(receiptEmail("Fictional Plumbing", owed).subject).toBe(
      "Your AnswerMate receipt: 31 Jan 2027 to 27 Feb 2027",
    );
  });

  it("escapes a business name in the HTML, and leaves the text as written", () => {
    const name = `O'Neill & Daughters <b>"Plumbing"</b>`;
    const charge = {
      periodStart: "2027-01-31",
      periodEnd: "2027-02-28",
      lines: [{ description: "AI Answering plan", pence: 9900 }],
      vatRatePercent: 0,
      vatPence: 0,
      totalPence: 9900,
      vatNumber: null,
      chargeDate: "2027-03-04",
    };
    for (const email of [receiptEmail(name, charge), paymentFailedEmail(name, charge)]) {
      expect(email.html).not.toContain("<b>");
      expect(email.html).toContain("&lt;b&gt;");
      expect(email.text).toContain(name);
    }
  });

  it("says the assistant is still answering only to a business whose assistant is", () => {
    const situations = [
      "onboarding",
      "live",
      "paused",
      "suspended",
      "cancelling",
      "cancelled",
      "demo",
    ].map((status) => [status, billingSituation(status)]);
    expect(situations).toEqual([
      ["onboarding", "not-answering"],
      ["live", "answering"],
      ["paused", "not-answering"],
      ["suspended", "not-answering"],
      ["cancelling", "leaving"],
      ["cancelled", "leaving"],
      ["demo", "answering"],
    ]);
    const charge = { periodStart: "2027-01-31", periodEnd: "2027-02-28", totalPence: 11_928 };
    for (const [status, situation] of situations) {
      const { text } = paymentFailedEmail("Fictional Plumbing", charge, billingSituation(status!));
      expect(text.includes("still answering"), status).toBe(situation === "answering");
      expect(text).toContain("We couldn't collect £119.28 by Direct Debit");
    }
  });
});

/** RFC 4180, the other way: what a spreadsheet reads back from toCsv's output. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && csv[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else {
      field += c;
    }
  }
  return rows;
}

describe("toCsv reads back as written", () => {
  it("round-trips thousands of awkward cells, defusing only the ones a spreadsheet would run", () => {
    const pieces = ["a", ",", '"', "\n", "\r\n", " ", "£", "=", "+", "-", "@", "\t", "é", "'", "0"];
    let seed = 5;
    const next = (below: number) => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % below;
    };
    for (let trial = 0; trial < 3_000; trial++) {
      const cells = Array.from({ length: 1 + next(4) }, () =>
        Array.from({ length: next(8) }, () => pieces[next(pieces.length)]!).join(""),
      );
      const [read] = parseCsv(
        toCsv(
          cells.map((_, i) => `h${i}`),
          [cells],
        ),
      ).slice(1);
      const expected = cells.map((cell) => (/^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell));
      expect(read, JSON.stringify(cells)).toEqual(expected);
    }
  });

  it("writes pence, whole numbers and big ones, exactly as they are", () => {
    for (const pence of [0, 1, 99, 100, 9900, 11_928, 2_147_483_647, Number.MAX_SAFE_INTEGER]) {
      expect(toCsv(["pence"], [[pence]])).toBe(`pence\r\n${pence}\r\n`);
    }
    expect(toCsv(["pence"], [[12_345_678_901_234_567_890n]])).toBe(
      "pence\r\n12345678901234567890\r\n",
    );
  });
});
