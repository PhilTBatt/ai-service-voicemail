// What Twilio is told to do with a call. Built with Twilio's TwiML builder so text is
// escaped properly. The snapshot tests pin the exact XML.
import twilio from "twilio";
import { FALLBACK_VOICEMAIL_GREETING, SERVICE_ENDED_LINE } from "./scripts.ts";

const VoiceResponse = twilio.twiml.VoiceResponse;
/** A British voice for the two messages Twilio speaks itself. */
const SAY = { voice: "Polly.Amy" as const, language: "en-GB" as const };

/** Connects the caller to the registered agent. When the dial ends, Twilio asks `actionUrl` what next. */
export function agentDial(sipUri: string, actionUrl: string): string {
  const response = new VoiceResponse();
  response.dial({ action: actionUrl, method: "POST", answerOnBridge: true }).sip(sipUri);
  return response.toString();
}

/** The Appendix A fallback voicemail: greeting, then up to two minutes of recording. */
export function fallbackVoicemail(recordingActionUrl: string): string {
  const response = new VoiceResponse();
  response.say(SAY, FALLBACK_VOICEMAIL_GREETING);
  response.record({ action: recordingActionUrl, method: "POST", maxLength: 120, playBeep: true });
  return response.toString();
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
