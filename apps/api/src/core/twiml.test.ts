import { describe, expect, it } from "vitest";
import {
  agentDial,
  fallbackVoicemail,
  fallbackVoicemailBin,
  hangup,
  rejectCall,
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

  it("builds the same voicemail as a self-contained TwiML Bin, with no API URL but the callback", () => {
    const bin = fallbackVoicemailBin(URLS.recordingStatusCallbackUrl);
    expect(bin).toMatchSnapshot();
    expect(bin).toContain("{{#if RecordingUrl}}");
    expect(bin).toContain("Sorry, the assistant isn't available right now.");
    expect(bin).toContain("Thanks. Goodbye.");
    expect(bin).not.toContain("action=");
    expect(bin.match(/https:\/\//g)).toHaveLength(1);
  });

  it("tells callers of a cancelled tenant to ring the business mobile, digit by digit", () => {
    const xml = serviceEnded("+447700900001");
    expect(xml).toMatchSnapshot();
    expect(xml).toContain('<say-as interpret-as="telephone">07700 900001</say-as>');
  });

  it("copes with a cancelled tenant that has no mobile on file", () => {
    expect(serviceEnded(null)).toMatchSnapshot();
  });

  it("rejects and hangs up", () => {
    expect(rejectCall()).toMatchSnapshot();
    expect(hangup()).toMatchSnapshot();
  });

  it("escapes anything that could break the XML", () => {
    expect(agentDial("sip:a&b@x", "https://example.com/?a=1&b=2")).toContain("a=1&amp;b=2");
  });
});
