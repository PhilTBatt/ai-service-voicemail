// How values read on screen. Pure functions, tested in format.test.ts.
import type { TenantListItem } from "@callmate/shared";
import type { Tone } from "./design/tone.ts";

/** "heating_engineer" → "Heating engineer" */
export function humanise(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whole pence as money: 148 → "£1.48". Integer maths only, like the money itself. */
export function formatPence(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const whole = Math.abs(pence);
  return `${sign}£${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, "0")}`;
}

/** Small amounts as people say them: "2p", "45p"; a pound or more as formatPence writes it. */
export function formatPenceWords(pence: number): string {
  return Math.abs(pence) < 100 ? `${pence}p` : formatPence(pence);
}

const DIRECT_DEBIT_LABELS: Record<TenantListItem["billing"]["directDebit"], string> = {
  none: "no Direct Debit",
  pending: "Direct Debit started",
  active: "Direct Debit set up",
  ended: "Direct Debit ended",
};

/** A month's charge in a few words (BillingChargeView.status). */
export const CHARGE_STATUS_LABELS: Record<string, string> = {
  nothing_due: "nothing due",
  below_minimum: "under £1, waived",
  no_mandate: "owed, no Direct Debit",
  collecting: "being collected",
  pending: "being collected",
  submitted: "being collected",
  confirmed: "paid",
  paid_out: "paid",
  failed: "payment failed",
  cancelled: "payment cancelled",
  charged_back: "payment reversed",
};

/** The colour a month's charge is shown in: paid green, trouble red, waiting blue. */
export function chargeTone(status: string): Tone {
  if (status === "confirmed" || status === "paid_out") return "success";
  if (status === "failed" || status === "cancelled" || status === "charged_back") return "danger";
  if (status === "no_mandate") return "warning";
  if (status === "collecting" || status === "pending" || status === "submitted") return "info";
  return "neutral";
}

/** "Pilot · Direct Debit set up · last month: paid": the plan and billing status, no amounts. */
export function billingSummary(billing: TenantListItem["billing"]): string {
  return [
    billing.isPilot ? "Pilot" : "Plan",
    DIRECT_DEBIT_LABELS[billing.directDebit],
    ...(billing.lastCharge
      ? [`last month: ${CHARGE_STATUS_LABELS[billing.lastCharge] ?? billing.lastCharge}`]
      : []),
  ].join(" · ");
}

/** A call's length: "0:42", "2:05". */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * A call's length in words, which can't be mistaken for a time of day beside one: "2 min",
 * "42 sec", "2 min 5 sec". The same words as the page behind a text's link (call-page.ts).
 */
export function formatDurationWords(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) return `${rest} sec`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
}

/**
 * A UK number as people write it: "+447700900123" → "07700 900123". Other UK numbers lose the
 * +44 but aren't grouped (area codes vary in length). Non-UK numbers are left alone. The same
 * rule as nationalNumber() in apps/api/src/core/notifications.ts, so texts and pages agree.
 */
export function formatPhone(e164: string): string {
  if (!e164.startsWith("+44")) return e164;
  const national = `0${e164.slice(3)}`;
  return national.length === 11 && national.startsWith("07")
    ? `${national.slice(0, 5)} ${national.slice(5)}`
    : national;
}

/**
 * What people put between a number's digits, and nothing else: spaces (non-breaking too),
 * brackets, dots, dashes of every width (\p{Pd}), and invisible formatting marks (\p{Cf}), such
 * as the direction marks a phone adds when a number is copied from its contacts (an iPhone
 * wraps it in U+202A and U+202C).
 */
const NUMBER_PUNCTUATION = /[\s().\p{Pd}\p{Cf}]/gu;

/**
 * A mobile number as people type it, in the form the API stores: "07700 900123",
 * "+44 7700 900123", "+44 (0)7700 900123" and "0044 7700 900123" all become "+447700900123".
 * Anything else comes back with only its punctuation removed, for the schema to refuse with a
 * proper message.
 */
export function toUkMobileE164(typed: string): string {
  const compact = typed.replace(NUMBER_PUNCTUATION, "");
  if (/^07\d{9}$/.test(compact)) return `+44${compact.slice(1)}`;
  // The international prefix, written "+44", "0044" or plain "44", with or without the
  // national 0 after it ("+44 (0)7700…", as UK letterheads write it).
  const international = /^(?:\+|00)?440?(7\d{9})$/.exec(compact);
  if (international) return `+44${international[1]!}`;
  return compact;
}

export const URGENCY_LABELS: Record<string, string> = {
  emergency: "Emergency",
  urgent: "Urgent",
  routine: "Routine",
  spam: "Spam",
  other: "Other",
};

export function urgencyLabel(urgency: string | null): string {
  return urgency === null ? "Not sorted yet" : (URGENCY_LABELS[urgency] ?? humanise(urgency));
}

const URGENCY_TONES: Record<string, Tone> = {
  emergency: "danger",
  urgent: "warning",
  routine: "info",
};

/** The colour an urgency is shown in: red for emergencies, amber for urgent, blue for routine. */
export function urgencyTone(urgency: string | null): Tone {
  return (urgency !== null && URGENCY_TONES[urgency]) || "neutral";
}

/** A business's status as its owner would say it, and the colour it's shown in. */
const STATUSES: Record<string, { label: string; tone: Tone }> = {
  live: { label: "Answering", tone: "success" },
  paused: { label: "Switched off", tone: "warning" },
  suspended: { label: "Suspended", tone: "danger" },
  onboarding: { label: "Setting up", tone: "info" },
  cancelling: { label: "Leaving", tone: "warning" },
  cancelled: { label: "Left", tone: "neutral" },
  demo: { label: "Demo line", tone: "brand" },
};

export function statusDisplay(status: string): { label: string; tone: Tone } {
  return STATUSES[status] ?? { label: humanise(status), tone: "neutral" };
}

/** "Fern Lane Plumbing" → "FL", "robin" → "R": up to two initials, or "?" with no name. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const initials = words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
  return initials === "" ? "?" : initials;
}
