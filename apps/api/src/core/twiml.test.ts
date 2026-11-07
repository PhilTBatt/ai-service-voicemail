import { describe, expect, it } from "vitest";
import {
  agentDial,
  demoLimitReached,
  fallbackVoicemail,
  fallbackVoicemailBins,
  hangup,
  noSmsReply,
  rejectCall,
  smsReply,
  serviceEnded,
  voicemailDone,
} from "./twiml.ts";

const URLS = {
  actionUrl: "https://example.com/webhooks/twilio/voicemail-done",
  recordingStatusCallbackUrl: "https://example.com/webhooks/twilio/recording",
};

describe("TwiML", () => {
  it("dials the agent's SIP URI and reports back when the dial ends", () => {
    const xml = agentDial(
      "sip:call_123@sip.retellai.com",
      "https://example.com/webhooks/twilio/dial-status",
    );
    expect(xml).toMatchSnapshot();
    expect(xml).toContain("<Sip>sip:call_123@sip.retellai.com</Sip>");
  });

  it("plays the fallback greeting, records for up to two minutes, and reports the recording separately", () => {
    const xml = fallbackVoicemail(URLS);
    expect(xml).toMatchSnapshot();
    expect(xml).toContain('maxLength="120"');
    expect(xml).toContain("Sorry, the assistant isn't available right now.");
    expect(xml).toContain('action="https://example.com/webhooks/twilio/voicemail-done"');
    expect(xml).toContain(
      'recordingStatusCallback="https://example.com/webhooks/twilio/recording"',
    );
  });

  it("thanks the caller and hangs up after the recording", () => {
    expect(voicemailDone()).toMatchSnapshot();
  });

  it("builds the voicemail as two static bins: the greeting records, then hands over to the thank-you bin", () => {
    const done = fallbackVoicemailBins.done();
    const greeting = fallbackVoicemailBins.greeting(
      "https://handler.twilio.com/twiml/EHdone",
      URLS.recordingStatusCallbackUrl,
    );
    expect(done).toMatchSnapshot();
    expect(greeting).toMatchSnapshot();
    expect(done).toContain("Thanks. Goodbye.");
    expect(greeting).toContain("Sorry, the assistant isn't available right now.");
    expect(greeting).toContain('action="https://handler.twilio.com/twiml/EHdone"');
    expect(greeting).toContain(
      'recordingStatusCallback="https://example.com/webhooks/twilio/recording"',
    );
    // No templating: Twilio's bin editor rejects it.
    expect(done + greeting).not.toContain("{{");
  });

  it("tells callers of a cancelled tenant to ring the business mobile, digit by digit", () => {
    const xml = serviceEnded("+447700900001");
    expect(xml).toMatchSnapshot();
    expect(xml).toContain('<say-as interpret-as="telephone">07700 900001</say-as>');
  });

  it("copes with a cancelled tenant that has no mobile on file", () => {
    expect(serviceEnded(null)).toMatchSnapshot();
  });

  it("tells a demo caller who has used today's calls to try tomorrow", () => {
    const xml = demoLimitReached();
    expect(xml).toMatchSnapshot();
    expect(xml).toContain("three calls a day");
    expect(xml).toContain("<Hangup/>");
  });

  it("rejects and hangs up", () => {
    expect(rejectCall()).toMatchSnapshot();
    expect(hangup()).toMatchSnapshot();
  });

  it("replies to a text, or deliberately says nothing", () => {
    expect(smsReply("AnswerMate is ON & answering <calls>.")).toMatchSnapshot();
    expect(noSmsReply()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });

  it("escapes anything that could break the XML", () => {
    expect(agentDial("sip:a&b@x", "https://example.com/?a=1&b=2")).toContain("a=1&amp;b=2");
  });
});
