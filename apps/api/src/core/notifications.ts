// The texts and emails a tradesperson gets after a call (BUILD_PLAN Step 6). Pure
// formatting; the snapshot tests pin the exact wording.
import type { CallExtraction } from "./extraction.ts";
import type { TranscriptTurn } from "../providers/voice.ts";
import { UK_TIME_ZONE } from "./availability.ts";
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
  let summary = input.summary.split("\n").slice(0, 2).join(" ").trim();
  const compose = () =>
    toGsm7(
      [
        `${URGENCY_LABEL[input.urgency ?? "other"]}: ${who}`,
        summary,
        ...(input.callbackNumber ? [`Call back: tel:${input.callbackNumber}`] : []),
        `Details: ${input.callUrl}`,
      ].join("\n"),
    );
  let body = compose();
  // Two segments at most: a long summary is cut at a word boundary until it fits.
  while (smsEncoding(body).segments > 2 && summary.length > 20) {
    const room = Math.max(20, summary.length - (body.length - 306) - 3);
    summary = `${summary.slice(0, room).replace(/\s+\S*$/, "")}...`;
    body = compose();
  }
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

// ─── Email ─────────────────────────────────────────────────────────────────────────────

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface CallEmailInput extends CallNotificationInput {
  businessName: string;
  startedAt: Date;
  flags: string[];
  /** Null for calls whose transcript has been cleared by retention. */
  transcript: TranscriptTurn[] | null;
  /** The call page's recording link, or null when there is no recording. */
  recordingUrl: string | null;
}

export interface VoicemailEmailInput {
  businessName: string;
  startedAt: Date;
  callbackNumber: string | null;
  durationSeconds: number;
  callUrl: string;
  recordingUrl: string | null;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Friday 7 November 2026, 09:00" in UK time. Spelt out here, so no locale data can vary it. */
export function formatUkDateTime(at: Date): string {
  const local = Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(
    UK_TIME_ZONE,
  );
  const hh = String(local.hour).padStart(2, "0");
  const mm = String(local.minute).padStart(2, "0");
  return `${WEEKDAYS[local.dayOfWeek - 1]} ${local.day} ${MONTHS[local.month - 1]} ${local.year}, ${hh}:${mm}`;
}

/** Everything that goes into HTML goes through this: transcripts are caller-supplied text. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const FOOTER =
  "This email contains a caller's personal details. Please handle it with care and delete it when you no longer need it.";

function htmlDocument(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en-GB"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111; line-height: 1.5; max-width: 640px; margin: 0 auto; padding: 16px;">',
    body,
    `<p style="color: #666; font-size: 13px; margin-top: 32px;">${escapeHtml(FOOTER)}</p>`,
    "</body></html>",
  ].join("\n");
}

function detailsTable(rows: [string, string][]): string {
  return (
    '<table style="border-collapse: collapse; margin: 16px 0;">' +
    rows
      .map(
        ([label, value]) =>
          `<tr><th style="text-align: left; padding: 4px 16px 4px 0; color: #555; font-weight: 600;">${escapeHtml(label)}</th><td style="padding: 4px 0;">${value}</td></tr>`,
      )
      .join("") +
    "</table>"
  );
}

function link(url: string, label = url): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** The email for an agent-answered call: the text's details, plus the transcript. */
export function callEmail(input: CallEmailInput): EmailContent {
  const label = URGENCY_LABEL[input.urgency ?? "other"];
  const who = [
    input.callerName ?? "Unknown caller",
    input.callbackNumber ? nationalNumber(input.callbackNumber) : "number withheld",
  ].join(", ");
  const firstLine = input.summary.split("\n")[0]?.trim() ?? "";
  const subject = `${label}: ${who}${firstLine ? ` - ${firstLine}` : ""}`.slice(0, 150);
  const when = formatUkDateTime(input.startedAt);
  const speaker = (turn: TranscriptTurn) => (turn.role === "agent" ? "Assistant" : "Caller");

  const text = [
    `${label} call to ${input.businessName}`,
    when,
    "",
    `Caller: ${input.callerName ?? "not given"}`,
    `Number: ${input.callbackNumber ? `${nationalNumber(input.callbackNumber)} (tel:${input.callbackNumber})` : "withheld"}`,
    `Postcode: ${input.postcode ?? "not given"}`,
    "",
    "Summary",
    input.summary,
    ...(input.flags.length > 0 ? ["", `Flags: ${input.flags.join(", ")}`] : []),
    "",
    `Call page: ${input.callUrl}`,
    ...(input.recordingUrl ? [`Recording: ${input.recordingUrl}`] : []),
    "",
    "Transcript",
    ...(input.transcript
      ? input.transcript.map((turn) => `${speaker(turn)}: ${turn.text}`)
      : ["(no longer available)"]),
    "",
    "--",
    FOOTER,
  ].join("\n");

  const html = htmlDocument(
    subject,
    [
      `<h1 style="font-size: 20px; margin: 0 0 4px;">${escapeHtml(label)} call to ${escapeHtml(input.businessName)}</h1>`,
      `<p style="margin: 0; color: #555;">${escapeHtml(when)}</p>`,
      detailsTable([
        ["Caller", escapeHtml(input.callerName ?? "not given")],
        [
          "Number",
          input.callbackNumber
            ? link(`tel:${input.callbackNumber}`, nationalNumber(input.callbackNumber))
            : "withheld",
        ],
        ["Postcode", escapeHtml(input.postcode ?? "not given")],
        ...(input.flags.length > 0
          ? ([["Flags", escapeHtml(input.flags.join(", "))]] as [string, string][])
          : []),
      ]),
      `<h2 style="font-size: 16px; margin: 24px 0 8px;">Summary</h2>`,
      `<p style="margin: 0; white-space: pre-line;">${escapeHtml(input.summary)}</p>`,
      `<p style="margin: 16px 0;">${link(input.callUrl, "Open the call page")}${
        input.recordingUrl ? ` &middot; ${link(input.recordingUrl, "Listen to the recording")}` : ""
      }</p>`,
      `<h2 style="font-size: 16px; margin: 24px 0 8px;">Transcript</h2>`,
      input.transcript
        ? input.transcript
            .map(
              (turn) =>
                `<p style="margin: 0 0 8px;"><strong>${speaker(turn)}:</strong> ${escapeHtml(turn.text)}</p>`,
            )
            .join("\n")
        : `<p style="margin: 0; color: #666;">(no longer available)</p>`,
    ].join("\n"),
  );

  return { subject, text, html };
}

/** The email for a fallback voicemail: who, how long, and where to listen. */
export function voicemailEmail(input: VoicemailEmailInput): EmailContent {
  const from = input.callbackNumber ? nationalNumber(input.callbackNumber) : "a withheld number";
  const subject = `New voicemail from ${from} (${input.durationSeconds} sec)`;
  const when = formatUkDateTime(input.startedAt);
  const text = [
    `New voicemail for ${input.businessName}`,
    when,
    "",
    `The assistant wasn't available, so the caller left a ${input.durationSeconds}-second message.`,
    `Number: ${input.callbackNumber ? `${nationalNumber(input.callbackNumber)} (tel:${input.callbackNumber})` : "withheld"}`,
    "",
    ...(input.recordingUrl ? [`Listen: ${input.recordingUrl}`] : []),
    `Call page: ${input.callUrl}`,
    "",
    "--",
    FOOTER,
  ].join("\n");
  const html = htmlDocument(
    subject,
    [
      `<h1 style="font-size: 20px; margin: 0 0 4px;">New voicemail for ${escapeHtml(input.businessName)}</h1>`,
      `<p style="margin: 0; color: #555;">${escapeHtml(when)}</p>`,
      `<p>The assistant wasn't available, so the caller left a ${input.durationSeconds}-second message.</p>`,
      detailsTable([
        [
          "Number",
          input.callbackNumber
            ? link(`tel:${input.callbackNumber}`, nationalNumber(input.callbackNumber))
            : "withheld",
        ],
      ]),
      `<p style="margin: 16px 0;">${
        input.recordingUrl ? `${link(input.recordingUrl, "Listen to the voicemail")} &middot; ` : ""
      }${link(input.callUrl, "Open the call page")}</p>`,
    ].join("\n"),
  );
  return { subject, text, html };
}
