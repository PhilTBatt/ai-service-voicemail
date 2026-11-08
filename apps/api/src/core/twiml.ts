// What Twilio is told to do with a call. Built with Twilio's TwiML builder so text is
// escaped properly. The snapshot tests pin the exact XML.
import twilio from "twilio";
import { nationalNumber } from "./notifications.ts";
import {
  DEMO_LIMIT_LINE,
  FALLBACK_VOICEMAIL_GREETING,
  SERVICE_ENDED_LINE,
  VOICEMAIL_THANKS,
} from "./scripts.ts";

const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;
/** A British voice for the messages Twilio speaks itself. */
const SAY = { voice: "Polly.Amy" as const, language: "en-GB" as const };
export const VOICEMAIL_MAX_SECONDS = 120;

/** Connects the caller to the registered agent. When the dial ends, Twilio asks `actionUrl` what next. */
export function agentDial(sipUri: string, actionUrl: string): string {
  const response = new VoiceResponse();
  // Ten seconds for the voice platform to answer (Twilio adds five): if it doesn't, the caller
  // gets the voicemail instead of half a minute of ringing (Twilio's default is 30 s).
  response
    .dial({ action: actionUrl, method: "POST", answerOnBridge: true, timeout: 10 })
    .sip(sipUri);
  return response.toString();
}

export interface VoicemailUrls {
  /** Asked what to do once the recording ends (Twilio ignores any TwiML after <Record>). */
  actionUrl: string;
  /** Told, separately, when the recording is ready: this is what stores the voicemail. */
  recordingStatusCallbackUrl: string;
}

/** The Appendix A fallback voicemail, as served by the API itself. */
export function fallbackVoicemail({
  actionUrl,
  recordingStatusCallbackUrl,
}: VoicemailUrls): string {
  const response = new VoiceResponse();
  response.say(SAY, FALLBACK_VOICEMAIL_GREETING);
  response.record({
    action: actionUrl,
    method: "POST",
    maxLength: VOICEMAIL_MAX_SECONDS,
    playBeep: true,
    recordingStatusCallback: recordingStatusCallbackUrl,
    recordingStatusCallbackMethod: "POST",
  });
  return response.toString();
}

/** What the caller hears once their voicemail is recorded. */
export function voicemailDone(): string {
  const response = new VoiceResponse();
  response.say(SAY, VOICEMAIL_THANKS);
  response.hangup();
  return response.toString();
}

/**
 * The same voicemail as two TwiML Bins, hosted by Twilio apart from the API, for the number's
 * fallback URL. Bins are static documents (Twilio's editor rejects templating), so the
 * "thanks, goodbye" lives in its own bin and the greeting's <Record> points at it. The only
 * API URL in either is the recording callback; if the API is down, the recording still
 * exists at Twilio and the reconciliation job picks it up.
 */
export const fallbackVoicemailBins = {
  /** Create this one first; the greeting needs its URL. */
  done: (): string => voicemailDone(),
  greeting: (doneBinUrl: string, recordingStatusCallbackUrl: string): string => {
    const response = new VoiceResponse();
    response.say(SAY, FALLBACK_VOICEMAIL_GREETING);
    response.record({
      action: doneBinUrl,
      method: "POST",
      maxLength: VOICEMAIL_MAX_SECONDS,
      playBeep: true,
      recordingStatusCallback: recordingStatusCallbackUrl,
      recordingStatusCallbackMethod: "POST",
    });
    return response.toString();
  },
};

/** For cancelling and cancelled tenants. The mobile is read digit by digit. */
export function serviceEnded(mobile: string | null): string {
  const response = new VoiceResponse();
  if (mobile === null) {
    response.say(SAY, `${SERVICE_ENDED_LINE} the business directly. Goodbye.`);
  } else {
    const say = response.say(SAY, `${SERVICE_ENDED_LINE} `);
    say.sayAs({ "interpret-as": "telephone" }, nationalNumber(mobile));
    say.addText(". Goodbye.");
  }
  response.hangup();
  return response.toString();
}

/** A demo caller who has used today's calls (routing.ts DEMO_DAILY_CALLS_PER_CALLER). */
export function demoLimitReached(): string {
  const response = new VoiceResponse();
  response.say(SAY, DEMO_LIMIT_LINE);
  response.hangup();
  return response.toString();
}

export function rejectCall(): string {
  const response = new VoiceResponse();
  response.reject({ reason: "rejected" });
  return response.toString();
}

export function hangup(): string {
  const response = new VoiceResponse();
  response.hangup();
  return response.toString();
}

/** Replies to an inbound text (Twilio sends it from the number that was texted). */
export function smsReply(text: string): string {
  const response = new MessagingResponse();
  response.message(text);
  return response.toString();
}

/** No reply at all: for unknown senders and for replies the outbound allowlist blocks. */
export function noSmsReply(): string {
  return new MessagingResponse().toString();
}
