// The billing emails (BUILD_PLAN Step 12): a receipt for each month's charge, a note when a
// payment couldn't be collected, and one when a Direct Debit ends. Pure: the job fills them in.
// Receipts until Brockersby is VAT registered; from then, a month charged with VAT has a VAT
// invoice (core/invoice.ts), and its email is that invoice, with everything HMRC lists.
import { formatPence } from "./billing.ts";
import { invoiceNumberText, type Invoice } from "./invoice.ts";
import { escapeHtml } from "./notifications.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-14" → "14 Oct 2026". */
export function formatDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Expected a date like 2026-10-14, got "${date}"`);
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]!} ${match[1]!}`;
}

/** The last day of a billing month: the period is [start, end), so the day before `end`. */
export function lastDayOf(periodEnd: string): string {
  return Temporal.PlainDate.from(periodEnd).subtract({ days: 1 }).toString();
}

export interface ReceiptCharge {
  periodStart: string;
  periodEnd: string;
  lines: { description: string; pence: number }[];
  vatRatePercent: number;
  vatPence: number;
  totalPence: number;
  vatNumber: string | null;
  /** The day the money is collected, if a payment was made; null when nothing was due. */
  chargeDate: string | null;
  /** The month's VAT invoice, when it was charged with VAT: the email is then that invoice. */
  invoice?: Invoice | null;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function document(title: string, paragraphs: string[], table?: string): string {
  return [
    "<!doctype html>",
    '<html lang="en-GB"><head><meta charset="utf-8"><title>',
    escapeHtml(title),
    '</title></head><body style="font-family: sans-serif; line-height: 1.5; color: #1a1a1a">',
    ...paragraphs.slice(0, 1).map((p) => `<p>${escapeHtml(p)}</p>`),
    table ?? "",
    ...paragraphs.slice(1).map((p) => `<p>${escapeHtml(p)}</p>`),
    "</body></html>",
  ].join("");
}

const SIGN_OFF = "AnswerMate, from Brockersby";

/** The month's receipt: what it covered, each part, VAT if any, the total, and when it's taken. */
export function receiptEmail(businessName: string, charge: ReceiptCharge): EmailContent {
  if (charge.invoice) return invoiceEmail(charge.invoice, charge.chargeDate);
  const period = `${formatDate(charge.periodStart)} to ${formatDate(lastDayOf(charge.periodEnd))}`;
  const rows: [string, number][] = [
    ...charge.lines.map((line): [string, number] => [line.description, line.pence]),
    ...(charge.vatRatePercent > 0
      ? [[`VAT at ${charge.vatRatePercent}%`, charge.vatPence] as [string, number]]
      : []),
  ];
  const collection =
    charge.totalPence === 0
      ? "There's nothing to pay for this month."
      : charge.chargeDate
        ? `This will be collected by Direct Debit on or soon after ${formatDate(charge.chargeDate)}.`
        : "This will be collected by Direct Debit in the next few days.";
  // Only what's true of this month: a month that began before VAT registration has none
  // charged, whatever the position by the time the receipt goes.
  const vatNote = charge.vatNumber
    ? `VAT registration number: ${charge.vatNumber}.`
    : "No VAT is charged on this month.";
  const intro = `Here's your AnswerMate receipt for ${businessName}, for ${period}.`;
  const text = [
    intro,
    "",
    ...rows.map(([label, pence]) => `${label}: ${formatPence(pence)}`),
    `Total: ${formatPence(charge.totalPence)}`,
    "",
    collection,
    vatNote,
    "",
    SIGN_OFF,
  ].join("\n");
  const table = [
    '<table style="border-collapse: collapse">',
    ...rows.map(
      ([label, pence]) =>
        `<tr><td style="padding: 4px 16px 4px 0">${escapeHtml(label)}</td><td style="text-align: right">${escapeHtml(formatPence(pence))}</td></tr>`,
    ),
    `<tr><td style="padding: 4px 16px 4px 0; border-top: 1px solid #ccc"><strong>Total</strong></td><td style="text-align: right; border-top: 1px solid #ccc"><strong>${escapeHtml(formatPence(charge.totalPence))}</strong></td></tr>`,
    "</table>",
  ].join("");
  return {
    subject: `Your AnswerMate receipt: ${period}`,
    text,
    html: document(`AnswerMate receipt`, [intro, collection, vatNote, SIGN_OFF], table),
  };
}

const cell = (text: string, align: "left" | "right" = "left", bold = false) =>
  `<td style="padding: 4px 12px 4px 0; text-align: ${align}">${bold ? `<strong>${escapeHtml(text)}</strong>` : escapeHtml(text)}</td>`;

/**
 * A month's VAT invoice as an email: who it's from and to, its number and date, each line with
 * its quantity, unit price, VAT rate and amount before VAT, then the totals (core/invoice.ts).
 */
export function invoiceEmail(invoice: Invoice, chargeDate: string | null): EmailContent {
  const number = invoiceNumberText(invoice.number);
  const period = `${formatDate(invoice.periodStart)} to ${formatDate(lastDayOf(invoice.periodEnd))}`;
  const customerAddress =
    invoice.customer.address ?? "Address not given (add it on your AnswerMate Account page)";
  const collection =
    invoice.totalPence === 0
      ? "There's nothing to pay for this month."
      : chargeDate
        ? `This will be collected by Direct Debit on or soon after ${formatDate(chargeDate)}.`
        : "This will be collected by Direct Debit in the next few days.";
  const header = [
    `VAT invoice ${number}`,
    `Date of issue and time of supply: ${formatDate(invoice.issuedOn)}`,
    `For: AnswerMate, ${period}`,
    "",
    `From: ${invoice.supplier.name}, ${invoice.supplier.address}`,
    `VAT registration number: ${invoice.supplier.vatNumber}`,
    `To: ${invoice.customer.name}, ${customerAddress}`,
  ];
  const lineText = invoice.lines.map(
    (line) =>
      `${line.description}: ${line.quantity} ${line.unit}${line.quantity === 1 ? "" : "s"} at ${formatPence(line.unitPence)}, VAT ${line.vatRatePercent}%, ${formatPence(line.pence)} before VAT`,
  );
  const totals = [
    `Total before VAT: ${formatPence(invoice.netPence)}`,
    `VAT at ${invoice.vatRatePercent}%: ${formatPence(invoice.vatPence)}`,
    `Total: ${formatPence(invoice.totalPence)}`,
  ];
  const text = [...header, "", ...lineText, "", ...totals, "", collection, "", SIGN_OFF].join("\n");
  const table = [
    '<table style="border-collapse: collapse">',
    `<tr>${cell("Description", "left", true)}${cell("Quantity", "right", true)}${cell("Unit price", "right", true)}${cell("VAT rate", "right", true)}${cell("Amount before VAT", "right", true)}</tr>`,
    ...invoice.lines.map(
      (line) =>
        `<tr>${cell(line.description)}${cell(`${line.quantity} ${line.unit}${line.quantity === 1 ? "" : "s"}`, "right")}${cell(formatPence(line.unitPence), "right")}${cell(`${line.vatRatePercent}%`, "right")}${cell(formatPence(line.pence), "right")}</tr>`,
    ),
    `<tr><td colspan="4" style="padding: 4px 12px 4px 0; border-top: 1px solid #ccc">Total before VAT</td>${cell(formatPence(invoice.netPence), "right")}</tr>`,
    `<tr><td colspan="4" style="padding: 4px 12px 4px 0">VAT at ${invoice.vatRatePercent}%</td>${cell(formatPence(invoice.vatPence), "right")}</tr>`,
    `<tr><td colspan="4" style="padding: 4px 12px 4px 0"><strong>Total</strong></td>${cell(formatPence(invoice.totalPence), "right", true)}</tr>`,
    "</table>",
  ].join("");
  return {
    subject: `Your AnswerMate VAT invoice ${number}: ${period}`,
    text,
    html: document(
      `AnswerMate VAT invoice ${number}`,
      [header.filter((line) => line !== "").join(". ") + ".", collection, SIGN_OFF],
      table,
    ),
  };
}

/**
 * Whether the business is answering calls (live), or not (paused, suspended), or leaving: the
 * billing emails used to tell everyone "your assistant is still answering your calls", and a
 * business that had left to set its Direct Debit up again.
 */
export type BillingEmailSituation = "answering" | "not-answering" | "leaving";

export function billingSituation(status: string): BillingEmailSituation {
  if (status === "live" || status === "demo") return "answering";
  if (status === "cancelling" || status === "cancelled") return "leaving";
  return "not-answering";
}

/** A month's payment couldn't be collected. The service carries on; this asks them to check. */
export function paymentFailedEmail(
  businessName: string,
  charge: { periodStart: string; periodEnd: string; totalPence: number },
  situation: BillingEmailSituation = "answering",
): EmailContent {
  const period = `${formatDate(charge.periodStart)} to ${formatDate(lastDayOf(charge.periodEnd))}`;
  const check =
    "Please check with your bank that the account has the funds and the Direct Debit is still in place, and we'll be in touch about collecting it.";
  const paragraphs = [
    `We couldn't collect ${formatPence(charge.totalPence)} by Direct Debit for ${businessName}'s AnswerMate, for ${period}.`,
    situation === "answering" ? `Your assistant is still answering your calls. ${check}` : check,
    SIGN_OFF,
  ];
  return {
    subject: "We couldn't collect your AnswerMate payment",
    text: paragraphs.join("\n\n"),
    html: document("AnswerMate payment", paragraphs),
  };
}

/** The Direct Debit ended: the link to set it up again, or, for a business that has left, what's owed. */
export function directDebitEndedEmail(
  businessName: string,
  accountUrl: string,
  situation: BillingEmailSituation = "answering",
): EmailContent {
  const ended = `The Direct Debit for ${businessName}'s AnswerMate has ended, so we can't collect payments from it any more.`;
  const paragraphs =
    situation === "leaving"
      ? [
          ended,
          "You've left AnswerMate, so nothing is due after the month you left in. If that month, or one before it, hasn't been collected yet, we'll be in touch about it.",
          SIGN_OFF,
        ]
      : [
          ended,
          `${situation === "answering" ? "Your assistant is still answering your calls. " : ""}Please set it up again from your account page: ${accountUrl}`,
          "If you meant to cancel AnswerMate, there's a button for that on the same page.",
          SIGN_OFF,
        ];
  return {
    subject: "Your AnswerMate Direct Debit has ended",
    text: paragraphs.join("\n\n"),
    html: document("AnswerMate Direct Debit", paragraphs),
  };
}
