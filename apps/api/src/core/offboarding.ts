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

/**
 * The written confirmation that a business's data is gone (BUILD_PLAN Step 13). Sent before the
 * address itself is deleted, so it says what will be true once the deletion finishes, which is
 * the same job a moment later.
 */
export function deletionConfirmationEmail(businessName: string): {
  subject: string;
  text: string;
  html: string;
} {
  const paragraphs = [
    `We've deleted the data AnswerMate held for ${businessName}: its calls, recordings, transcripts and messages, its assistant's settings, your contact details and your login. We've also deleted the copies held by the companies that handled your calls and texts for us, Retell AI and Twilio.`,
    "A few copies take a little longer to go. Twilio's backups can hold texts for up to 30 days, and Twilio keeps a note that each recording existed, without the recording, for 40 days. Postmark, which sends our emails, keeps copies of them for 45 days.",
    "We keep only what we have to: your billing totals, for as long as UK accounting rules require; the record that you accepted our terms; and a log of account actions, which holds no call content.",
    "This email is our written confirmation. Thank you for using AnswerMate.",
  ];
  return {
    subject: "Your AnswerMate data has been deleted",
    text: paragraphs.join("\n\n"),
    html: paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("\n"),
  };
}

/**
 * The same confirmation as a text, for a business whose email can't be used: still in writing.
 * GSM-7, so a long business name still fits in three segments.
 */
export function deletionConfirmationText(businessName: string): string {
  return `AnswerMate: we've deleted the data we held for ${businessName}, here and at Retell AI and Twilio, who handled your calls and texts. We keep only your billing totals, your acceptance of our terms and a log of account actions. This text is our written confirmation.`;
}

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
