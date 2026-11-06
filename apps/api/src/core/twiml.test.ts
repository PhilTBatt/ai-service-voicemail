import { describe, expect, it } from "vitest";
import { agentDial, fallbackVoicemail, hangup, rejectCall, serviceEnded } from "./twiml.ts";

describe("TwiML", () => {
  it("dials the agent's SIP URI and reports back when the dial ends", () => {
    const xml = agentDial(
      "sip:call_123@sip.retellai.com",
      "https://example.com/webhooks/twilio/dial-status",
    );
    expect(xml).toMatchSnapshot();
    expect(xml).toContain("<Sip>sip:call_123@sip.retellai.com</Sip>");
  });

  it("plays the fallback greeting and records for up to two minutes", () => {
    const xml = fallbackVoicemail("https://example.com/webhooks/twilio/recording");
    expect(xml).toMatchSnapshot();
    expect(xml).toContain('maxLength="120"');
    expect(xml).toContain("Sorry, the assistant isn't available right now.");
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
