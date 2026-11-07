// The texts and emails a tradesperson gets after a call (BUILD_PLAN Step 6). Pure
// formatting; the snapshot tests pin the exact wording.
import type { CallExtraction } from "./extraction.ts";
import { GAS_EMERGENCY_NUMBER } from "./scripts.ts";
import { smsEncoding, toGsm7 } from "./sms.ts";

export interface CallNotificationInput {
  urgency: CallExtraction["urgency"] | null;
  callerName: string | null;
  /** E.164, from the caller's own words or the caller ID. */
  callbackNumber: string | null;
  postcode: string | null;
  summary: string;
  /** Signed link to the call page (core/signed-links.ts). */
  callUrl: string;
}

const URGENCY_LABEL: Record<NonNullable<CallNotificationInput["urgency"]>, string> = {
  emergency: "EMERGENCY",
  urgent: "URGENT",
  routine: "New enquiry",
  spam: "Possible spam",
  other: "Call",
};

/** +447700900123 -> 07700 900123 */
export function nationalNumber(e164: string): string {
  const national = e164.replace(/^\+44/, "0");
  return national.length === 11 ? `${national.slice(0, 5)} ${national.slice(5)}` : national;
}

/**
 * The SMS. GSM-7 only, so it stays at 160 characters a segment; aimed at two segments
 * at most. The summary is trimmed to two lines.
 */
export function callSms(input: CallNotificationInput): { body: string; segments: number } {
  const who = [
    input.callerName,
    input.callbackNumber ? nationalNumber(input.callbackNumber) : "number withheld",
    input.postcode,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  const summary = input.summary.split("\n").slice(0, 2).join(" ").trim();
  const lines = [
    `${URGENCY_LABEL[input.urgency ?? "other"]}: ${who}`,
    summary,
    ...(input.callbackNumber ? [`Call back: tel:${input.callbackNumber}`] : []),
    `Details: ${input.callUrl}`,
  ];
  const body = toGsm7(lines.join("\n"));
  return { body, segments: smsEncoding(body).segments };
}

/**
 * The priority text to the tradesperson for an emergency call. Short on purpose: it has
 * to fit one segment and be read in a second. The full summary follows from notify-sms.
 */
export function emergencyTradespersonSms({ callbackNumber }: { callbackNumber: string | null }): {
  body: string;
  segments: number;
} {
  const who = callbackNumber
    ? `Call them back now: tel:${callbackNumber} (${nationalNumber(callbackNumber)}).`
    : "Their number was withheld.";
  const body = toGsm7(
    `EMERGENCY: a caller just reported an emergency to your AI assistant. ${who} Full details follow by text.`,
  );
  return { body, segments: smsEncoding(body).segments };
}

/**
 * The service message to the caller after the agent spoke the gas script (Appendix A):
 * the number, nothing else. No marketing, no link. One segment for business names up to
 * about 18 characters; longer names cost a second segment, which is fine for an emergency.
 */
export function emergencyCallerSms({
  businessName,
  region,
}: {
  businessName: string;
  region: keyof typeof GAS_EMERGENCY_NUMBER;
}): { body: string; segments: number } {
  const body = toGsm7(
    `${businessName} : if you smell gas or suspect carbon monoxide, call the National Gas Emergency Service now (free, 24hrs) on ${GAS_EMERGENCY_NUMBER[region]}. In danger? Call 999.`,
  );
  return { body, segments: smsEncoding(body).segments };
}

/** The text for a fallback voicemail: who, how long, and where to listen. */
export function voicemailSms({
  callbackNumber,
  durationSeconds,
  callUrl,
}: {
  callbackNumber: string | null;
  durationSeconds: number;
  callUrl: string;
}): { body: string; segments: number } {
  const from = callbackNumber ? nationalNumber(callbackNumber) : "a withheld number";
  const lines = [
    `New voicemail (${durationSeconds} sec) from ${from}. The assistant wasn't available, so the caller left a message.`,
    ...(callbackNumber ? [`Call back: tel:${callbackNumber}`] : []),
    `Listen: ${callUrl}`,
  ];
  const body = toGsm7(lines.join("\n"));
  return { body, segments: smsEncoding(body).segments };
}
