// The texts and emails a tradesperson gets after a call (BUILD_PLAN Step 6). Pure
// formatting; the snapshot tests pin the exact wording.
import type { CallExtraction } from "./extraction.ts";
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
