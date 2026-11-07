// Leaving AnswerMate (BUILD_PLAN Step 13): the timeline and what the business is told. Pure
// functions; jobs/offboarding.ts sends the messages and db/cross-tenant.ts applies the timeline.
//
// When a business cancels, callers to its number hear "service has ended" for 30 days, so
// nobody who rings is stranded while the tradesperson removes their divert. After that, an
// admin releases the number (a live action, so never automatic), and then its data can go.
import { DIVERT_TURN_OFF_CODES, MOBILE_NETWORKS, type MobileNetwork } from "@callmate/shared";

export const CANCELLATION_NOTICE_DAYS = 30;

/** When the number may be released: 30 days after the cancellation, counted in UK days. */
export function releaseDueAt(cancellationRequestedAt: Date): Date {
  const requested = Temporal.Instant.fromEpochMilliseconds(
    cancellationRequestedAt.getTime(),
  ).toZonedDateTimeISO("Europe/London");
  return new Date(requested.add({ days: CANCELLATION_NOTICE_DAYS }).epochMilliseconds);
}

export interface CancellationNoticeInput {
  businessName: string;
  network: MobileNetwork | null;
  /** The code kept when the divert instructions went out, or worked out from the network. */
  restoreCode: string | null;
}

function voicemailLine({ network, restoreCode }: CancellationNoticeInput): string {
  if (restoreCode) return `Then dial ${restoreCode} to get your voicemail back.`;
  const name = network && network !== "other" ? MOBILE_NETWORKS[network] : "your network";
  return `Then ask ${name} to turn your voicemail back on.`;
}

const TURN_OFF = DIVERT_TURN_OFF_CODES.join(", ");

/** The text: turn the diverts off, get voicemail back. GSM-7 and about two segments. */
export function cancellationText(input: CancellationNoticeInput): string {
  return (
    `AnswerMate: your service has been cancelled. To stop sending missed calls to it, dial ${TURN_OFF} on your mobile, pressing call after each. ` +
    `${voicemailLine(input)} Callers to your AnswerMate number hear that the service has ended for ${CANCELLATION_NOTICE_DAYS} days.`
  );
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The email: the same steps, plus what happens to their data. */
export function cancellationEmail(input: CancellationNoticeInput): {
  subject: string;
  text: string;
  html: string;
} {
  const paragraphs = [
    `AnswerMate for ${input.businessName} has been cancelled.`,
    `To stop sending your missed calls to it, dial each of these on your mobile and press call: ${TURN_OFF}.`,
    voicemailLine(input),
    `For the next ${CANCELLATION_NOTICE_DAYS} days, anyone who rings your AnswerMate number hears that the service has ended. After that we release the number, then delete your calls, recordings and details, and email you to confirm.`,
    "If you'd like a copy of your data, download it from the Account tab in your dashboard before then.",
  ];
  return {
    subject: "Your AnswerMate service has been cancelled",
    text: paragraphs.join("\n\n"),
    html: paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("\n"),
  };
}
