// What Twilio is told to do with a call. Built with Twilio's TwiML builder so text is
// escaped properly. The snapshot tests pin the exact XML.
import twilio from "twilio";
import { FALLBACK_VOICEMAIL_GREETING, SERVICE_ENDED_LINE, VOICEMAIL_THANKS } from "./scripts.ts";

const VoiceResponse = twilio.twiml.VoiceResponse;
/** A British voice for the messages Twilio speaks itself. */
const SAY = { voice: "Polly.Amy" as const, language: "en-GB" as const };
export const VOICEMAIL_MAX_SECONDS = 120;

/** Connects the caller to the registered agent. When the dial ends, Twilio asks `actionUrl` what next. */
export function agentDial(sipUri: string, actionUrl: string): string {
  const response = new VoiceResponse();
  response.dial({ action: actionUrl, method: "POST", answerOnBridge: true }).sip(sipUri);
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
 * The same voicemail as a TwiML Bin, hosted by Twilio apart from the API, for the number's
 * fallback URL. With no action, <Record> re-requests this same document, that time with a
 * RecordingUrl parameter, and the bin's Handlebars `if` turns that into the thank-you. The
 * only URL in it is the API's recording callback; if the API is down, the recording still
 * exists at Twilio and the reconciliation job picks it up.
 */
export function fallbackVoicemailBin(recordingStatusCallbackUrl: string): string {
  const thanks = voicemailDone()
    .replace(/^<\?xml[^>]*\?>/, "")
    .replace(/<\/?Response>/g, "");
  const greeting = new VoiceResponse();
  greeting.say(SAY, FALLBACK_VOICEMAIL_GREETING);
  greeting.record({
    maxLength: VOICEMAIL_MAX_SECONDS,
    playBeep: true,
    recordingStatusCallback: recordingStatusCallbackUrl,
    recordingStatusCallbackMethod: "POST",
  });
  const record = greeting
    .toString()
    .replace(/^<\?xml[^>]*\?>/, "")
    .replace(/<\/?Response>/g, "");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "{{#if RecordingUrl}}",
    `  ${thanks}`,
    "{{else}}",
    `  ${record}`,
    "{{/if}}",
    "</Response>",
  ].join("\n");
}

/** For cancelling and cancelled tenants. The mobile is read digit by digit. */
export function serviceEnded(mobile: string | null): string {
  const response = new VoiceResponse();
  if (mobile === null) {
    response.say(SAY, `${SERVICE_ENDED_LINE} the business directly. Goodbye.`);
  } else {
    const say = response.say(SAY, `${SERVICE_ENDED_LINE} `);
    say.sayAs({ "interpret-as": "telephone" }, nationalFormat(mobile));
    say.addText(". Goodbye.");
  }
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

/** +447700900123 → 07700 900123, which is how a UK caller expects to hear it. */
function nationalFormat(e164: string): string {
  const national = e164.replace(/^\+44/, "0");
  return national.length === 11 ? `${national.slice(0, 5)} ${national.slice(5)}` : national;
}
