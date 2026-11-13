// VAT invoices (HMRC VAT Notice 700/21 section 4.1, read 2026-11-13:
// https://www.gov.uk/guidance/record-keeping-for-vat-notice-70021#vat-rules). Once Brockersby
// is VAT registered, each month charged with VAT gets one: the month-end charge run builds it,
// stores it with the charge exactly as issued, and the receipt email and the Account page show it.
//
// What section 4.1 lists, and where each is here: a sequential number (`number`, one series,
// no gaps: jobs/charge-periods.ts takes it in the charge's own transaction); the time of supply
// and date of issue (`issuedOn`: the day the month is charged, both); the supplier's name, address
// and VAT number (`supplier`, from VAT_SELLER_NAME, VAT_SELLER_ADDRESS, VAT_REGISTRATION_NUMBER);
// the customer's name and address (`customer`, the business and its billing address); a
// description, quantity, unit price, VAT rate and amount excluding VAT for each line (`lines`);
// the total excluding VAT, the VAT and the total (`netPence`, `vatPence`, `totalPence`). No cash
// discount is offered, so there's no rate for one.
//
// A full invoice rather than a simplified one: section 4.5 allows a simplified invoice up to £250
// including VAT, but doesn't say a VAT-registered customer can reclaim VAT on one, and a month
// with many extra minutes can pass £250. Pure.
import type { Plan } from "@callmate/shared";
import type { Charge } from "./billing.ts";

export interface InvoiceSupplier {
  name: string;
  address: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  /** "month" or "minute": what the quantity counts. */
  unit: string;
  unitPence: number;
  vatRatePercent: number;
  /** quantity × unitPence: the line's amount, excluding VAT. */
  pence: number;
}

/** A VAT invoice as issued. Stored with the charge (billing_charges.invoice) and never changed. */
export interface Invoice {
  number: number;
  /** The date of issue, and the time of supply: the UK date the month was charged. */
  issuedOn: string;
  /** The billing month it covers, [start, end). */
  periodStart: string;
  periodEnd: string;
  supplier: InvoiceSupplier & { vatNumber: string };
  /** The address is null if the business hadn't given one: the invoice says so. */
  customer: { name: string; address: string | null };
  lines: InvoiceLine[];
  netPence: number;
  vatRatePercent: number;
  vatPence: number;
  totalPence: number;
}

/** "0042": the number as it's printed. Four digits until there are more. */
export function invoiceNumberText(number: number): string {
  return String(number).padStart(4, "0");
}

/** A VAT invoice for a month's charge. Throws if the charge has no VAT: that's a receipt. */
export function buildInvoice({
  number,
  issuedOn,
  supplier,
  vatNumber,
  customer,
  period,
  charge,
  plan,
}: {
  number: number;
  issuedOn: string;
  supplier: InvoiceSupplier;
  vatNumber: string;
  customer: { name: string; address: string | null };
  period: { periodStart: string; periodEnd: string };
  charge: Charge;
  plan: Plan;
}): Invoice {
  if (charge.vatRatePercent === 0)
    throw new Error("A month with no VAT gets a receipt, not a VAT invoice");
  const vatRatePercent = charge.vatRatePercent;
  const lines: InvoiceLine[] = [
    {
      description: charge.lines[0]?.description ?? `${plan.name} plan`,
      quantity: 1,
      unit: "month",
      unitPence: charge.feePence,
      vatRatePercent,
      pence: charge.feePence,
    },
    ...(charge.overageMinutes > 0
      ? [
          {
            description: `Minutes over the ${plan.includedMinutes} included`,
            quantity: charge.overageMinutes,
            unit: "minute",
            unitPence: plan.overagePencePerMinute,
            vatRatePercent,
            pence: charge.overagePence,
          },
        ]
      : []),
  ];
  const netPence = lines.reduce((total, line) => total + line.pence, 0);
  if (netPence !== charge.subtotalPence) {
    throw new Error(
      `The invoice's lines come to ${netPence}p, not the charge's ${charge.subtotalPence}p`,
    );
  }
  return {
    number,
    issuedOn,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    supplier: { ...supplier, vatNumber },
    customer,
    lines,
    netPence,
    vatRatePercent,
    vatPence: charge.vatPence,
    totalPence: charge.totalPence,
  };
}
