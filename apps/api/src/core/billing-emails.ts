// The billing emails (BUILD_PLAN Step 12): a receipt for each month's charge, a note when a
// payment couldn't be collected, and one when a Direct Debit ends. Pure: the job fills them in.
// Called receipts rather than invoices: until Brockersby is VAT registered there's no VAT, and a
// VAT invoice needs more than these show (HMRC VAT Notice 700/21 section 4.1: a sequential
// number, both sides' names and addresses). Those come before the VAT settings do.
import { formatPence } from "./billing.ts";
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
