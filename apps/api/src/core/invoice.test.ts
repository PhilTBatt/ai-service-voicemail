// VAT invoices (core/invoice.ts) and their email (core/billing-emails.ts): every detail HMRC's
// VAT Notice 700/21 section 4.1 lists is there, and the lines add up to the charge.
import { AI_ANSWERING_PLAN } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { invoiceEmail, receiptEmail } from "./billing-emails.ts";
import { chargeFor } from "./billing.ts";
import { buildInvoice, invoiceNumberText } from "./invoice.ts";

const plan = AI_ANSWERING_PLAN;
const period = { periodStart: "2027-01-20", periodEnd: "2027-02-20", index: 3 };
const vat = { number: "GB999999973", from: "2027-01-01" };
const supplier = { name: "Brockersby", address: "1 Example Street, Leeds, XQ1 2AB" };

const invoiceFor = (
  billableSeconds: number,
  address: string | null = "4 Fern Lane, Leeds, XQ12 3AB",
) =>
  buildInvoice({
    number: 42,
    issuedOn: "2027-02-20",
    supplier,
    vatNumber: vat.number,
    customer: { name: "Fern Lane Plumbing", address },
    period,
    charge: chargeFor({ plan, period, isPilot: false, billableSeconds, vat }),
    plan,
  });

describe("buildInvoice", () => {
  it("has a line for the plan and one for the extra minutes, each with quantity, unit price and VAT rate", () => {
    // 12,601 seconds is 211 minutes: 11 over, at 20p.
    const invoice = invoiceFor(12_601);
    expect(invoice.lines).toEqual([
      {
        description: "AI Answering plan",
        quantity: 1,
        unit: "month",
        unitPence: 9900,
        vatRatePercent: 20,
        pence: 9900,
      },
      {
        description: "Minutes over the 200 included",
        quantity: 11,
        unit: "minute",
        unitPence: 20,
        vatRatePercent: 20,
        pence: 220,
      },
    ]);
    expect(invoice).toMatchObject({
      number: 42,
      issuedOn: "2027-02-20",
      periodStart: "2027-01-20",
      periodEnd: "2027-02-20",
      supplier: { ...supplier, vatNumber: "GB999999973" },
      customer: { name: "Fern Lane Plumbing", address: "4 Fern Lane, Leeds, XQ12 3AB" },
      netPence: 10_120,
      vatRatePercent: 20,
      vatPence: 2024,
      totalPence: 12_144,
    });
  });

  it("has no extra-minutes line inside the included minutes", () => {
    const invoice = invoiceFor(200 * 60);
    expect(invoice.lines.map((line) => line.description)).toEqual(["AI Answering plan"]);
    expect(invoice).toMatchObject({ netPence: 9900, vatPence: 1980, totalPence: 11_880 });
  });

  it("refuses a month with no VAT: that's a receipt", () => {
    expect(() =>
      buildInvoice({
        number: 1,
        issuedOn: "2026-12-20",
        supplier,
        vatNumber: vat.number,
        customer: { name: "Fern Lane Plumbing", address: null },
        period: { periodStart: "2026-11-20", periodEnd: "2026-12-20" },
        charge: chargeFor({
          plan,
          period: { periodStart: "2026-11-20", periodEnd: "2026-12-20", index: 1 },
          isPilot: false,
          billableSeconds: 0,
          vat,
        }),
        plan,
      }),
    ).toThrow("A month with no VAT gets a receipt");
  });
});

describe("invoiceNumberText", () => {
  it("prints four digits until there are more", () => {
    expect(invoiceNumberText(1)).toBe("0001");
    expect(invoiceNumberText(42)).toBe("0042");
    expect(invoiceNumberText(12_345)).toBe("12345");
  });
});

describe("the VAT invoice email", () => {
  it("shows everything HMRC lists: number, date, both sides, VAT number, each line, the totals", () => {
    const email = invoiceEmail(invoiceFor(12_601), "2027-02-25");
    expect(email.subject).toBe("Your AnswerMate VAT invoice 0042: 20 Jan 2027 to 19 Feb 2027");
    for (const part of [
      "VAT invoice 0042",
      "Date of issue and time of supply: 20 Feb 2027",
      "From: Brockersby, 1 Example Street, Leeds, XQ1 2AB",
      "VAT registration number: GB999999973",
      "To: Fern Lane Plumbing, 4 Fern Lane, Leeds, XQ12 3AB",
      "AI Answering plan: 1 month at £99.00, VAT 20%, £99.00 before VAT",
      "Minutes over the 200 included: 11 minutes at £0.20, VAT 20%, £2.20 before VAT",
      "Total before VAT: £101.20",
      "VAT at 20%: £20.24",
      "Total: £121.44",
      "collected by Direct Debit on or soon after 25 Feb 2027",
    ]) {
      expect(email.text).toContain(part);
    }
    for (const part of [
      "VAT invoice 0042",
      "Unit price",
      "VAT rate",
      "Amount before VAT",
      "£121.44",
    ]) {
      expect(email.html).toContain(part);
    }
  });

  it("says when the business hasn't given its address", () => {
    expect(invoiceEmail(invoiceFor(0, null), null).text).toContain(
      "To: Fern Lane Plumbing, Address not given (add it on your AnswerMate Account page)",
    );
  });

  it("is what the receipt becomes when the month has an invoice", () => {
    const invoice = invoiceFor(0);
    const charge = chargeFor({ plan, period, isPilot: false, billableSeconds: 0, vat });
    const email = receiptEmail("Fern Lane Plumbing", {
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      lines: charge.lines,
      vatRatePercent: charge.vatRatePercent,
      vatPence: charge.vatPence,
      totalPence: charge.totalPence,
      vatNumber: vat.number,
      chargeDate: null,
      invoice,
    });
    expect(email).toEqual(invoiceEmail(invoice, null));
  });
});
