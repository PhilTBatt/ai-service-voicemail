// What Twilio is told, checked as a whole document: every reply is well-formed TwiML, says what
// Appendix A says word for word, and never leaves a caller on a silent line.
import { describe, expect, it } from "vitest";
import {
  DANGER_SCRIPT,
  FALLBACK_VOICEMAIL_GREETING,
  GAS_EMERGENCY_NUMBER,
  SERVICE_ENDED_LINE,
  VOICEMAIL_THANKS,
} from "./scripts.ts";
import {
  VOICEMAIL_MAX_SECONDS,
  agentDial,
  demoLimitReached,
  fallbackVoicemail,
  fallbackVoicemailBins,
  hangup,
  noSmsReply,
  rejectCall,
  serviceEnded,
  smsReply,
  voicemailDone,
} from "./twiml.ts";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const URLS = {
  actionUrl: "https://callmate.example.com/webhooks/twilio/voicemail-done",
  recordingStatusCallbackUrl: "https://callmate.example.com/webhooks/twilio/recording",
};

/** The verbs inside <Response>, in order: what Twilio will do. */
const verbs = (xml: string): string[] =>
  [...xml.replace(XML_HEAD, "").matchAll(/<([A-Z][A-Za-z]*)\b/g)]
    .map((match) => match[1]!)
    .filter((name) => name !== "Response");

describe("every TwiML reply", () => {
  const ALL: [string, string][] = [
    ["agentDial", agentDial("sip:call_1@sip.retellai.com", "https://callmate.example.com/d")],
    ["fallbackVoicemail", fallbackVoicemail(URLS)],
    ["voicemailDone", voicemailDone()],
    ["serviceEnded (mobile)", serviceEnded("+447700900001")],
    ["serviceEnded (none)", serviceEnded(null)],
    ["demoLimitReached", demoLimitReached()],
    ["rejectCall", rejectCall()],
    ["hangup", hangup()],
    ["bins.done", fallbackVoicemailBins.done()],
    [
      "bins.greeting",
      fallbackVoicemailBins.greeting(
        "https://handler.twilio.com/b2",
        URLS.recordingStatusCallbackUrl,
      ),
    ],
  ];

  it.each(ALL)("%s is one well-formed <Response>", (_name, xml) => {
    expect(xml.startsWith(`${XML_HEAD}<Response>`)).toBe(true);
    expect(xml.endsWith("</Response>")).toBe(true);
    // No raw ampersand anywhere: an unescaped one makes Twilio refuse the whole document.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);
  });

  it.each(ALL)("%s ends the caller's turn on purpose: never silence", (_name, xml) => {
    const sequence = verbs(xml);
    // Something is said, the call is handed on, or it's ended: never an empty document.
    expect(sequence.length).toBeGreaterThanOrEqual(1);
    const last = sequence.at(-1);
    expect(["Hangup", "Record", "Sip", "Reject"]).toContain(last);
  });
});

describe("the fallback voicemail", () => {
  it("speaks the greeting word for word, then records with a beep", () => {
    const xml = fallbackVoicemail(URLS);
    expect(verbs(xml)).toEqual(["Say", "Record"]);
    expect(xml).toContain(`>${FALLBACK_VOICEMAIL_GREETING}</Say>`);
    expect(xml).toContain(`maxLength="${VOICEMAIL_MAX_SECONDS}"`);
    expect(xml).toContain('playBeep="true"');
    expect(xml).toContain('recordingStatusCallbackMethod="POST"');
  });

  // Phil, 2026-11-11: a caller who smells gas or is in danger heard nothing but "leave a
  // message" when the assistant couldn't answer (an outage, a pause, the kill switch).
  it("tells a caller with gas or danger to hang up and ring, before the beep, in Appendix A's words", () => {
    // The numbers are written as words for the voice to read; put back as digits, the lines
    // are Appendix A's.
    const asDigits = FALLBACK_VOICEMAIL_GREETING.replace(
      "oh eight hundred, one one one, nine nine nine",
      GAS_EMERGENCY_NUMBER.GB,
    ).replace("call nine nine nine", "call 999");
    expect(asDigits).toContain(
      `If you can smell gas, or you think there's carbon monoxide, please hang up now and call ${GAS_EMERGENCY_NUMBER.GB}.`,
    );
    expect(asDigits).toContain(DANGER_SCRIPT);
    // No digits left for the voice to read as a quantity ("nine hundred and ninety-nine").
    expect(FALLBACK_VOICEMAIL_GREETING).not.toMatch(/\d/);
    // Safety first, then the message: the beep follows the last sentence.
    expect(FALLBACK_VOICEMAIL_GREETING.indexOf("gas")).toBeLessThan(
      FALLBACK_VOICEMAIL_GREETING.indexOf("leave your name"),
    );
    expect(FALLBACK_VOICEMAIL_GREETING).toMatch(
      /Please leave your name, your number and what you need after the tone, and you'll get a call back\.$/i,
    );
    // The bin served while the API is down says the same.
    const bin = fallbackVoicemailBins.greeting(URLS.actionUrl, URLS.recordingStatusCallbackUrl);
    expect(bin).toContain(`>${FALLBACK_VOICEMAIL_GREETING}</Say>`);
  });

  it("escapes an ampersand in its URLs", () => {
    const xml = fallbackVoicemail({
      actionUrl: "https://callmate.example.com/done?a=1&b=2",
      recordingStatusCallbackUrl: "https://callmate.example.com/rec?a=1&b=2",
    });
    expect(xml).toContain('action="https://callmate.example.com/done?a=1&amp;b=2"');
    expect(xml).toContain('recordingStatusCallback="https://callmate.example.com/rec?a=1&amp;b=2"');
  });

  it("is the same greeting in the static bins, which serve it while the API is down", () => {
    const api = fallbackVoicemail(URLS);
    const bin = fallbackVoicemailBins.greeting(URLS.actionUrl, URLS.recordingStatusCallbackUrl);
    expect(bin).toBe(api);
    // Bins are static: no templating that Twilio's editor would reject.
    expect(bin).not.toMatch(/\{\{|\}\}/);
    expect(fallbackVoicemailBins.done()).toBe(voicemailDone());
  });

  it("thanks the caller with the agreed words, then hangs up", () => {
    const xml = voicemailDone();
    expect(verbs(xml)).toEqual(["Say", "Hangup"]);
    expect(xml).toContain(`>${VOICEMAIL_THANKS}</Say>`);
  });
});

describe("the service-ended message", () => {
  it("names the mobile digit by digit, then hangs up, with no voicemail", () => {
    const xml = serviceEnded("+447700900001");
    expect(verbs(xml)).toEqual(["Say", "Hangup"]);
    expect(xml).toContain(
      `${SERVICE_ENDED_LINE} <say-as interpret-as="telephone">07700 900001</say-as>. Goodbye.`,
    );
    expect(xml).not.toContain("<Record");
  });

  it("asks callers to ring the business directly when there's no mobile", () => {
    const xml = serviceEnded(null);
    expect(xml).toContain(`>${SERVICE_ENDED_LINE} the business directly. Goodbye.</Say>`);
    expect(xml).not.toContain("say-as");
  });
});

describe("the agent dial", () => {
  it("waits ten seconds, bridges on answer, and asks what next when the leg ends", () => {
    const xml = agentDial("sip:call_9@sip.retellai.com", "https://callmate.example.com/d?x=1&y=2");
    expect(verbs(xml)).toEqual(["Dial", "Sip"]);
    expect(xml).toContain('action="https://callmate.example.com/d?x=1&amp;y=2"');
    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain('timeout="10"');
    expect(xml).toContain('method="POST"');
  });
});

describe("SMS replies", () => {
  it.each([
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["Tom & Jerry's", "Tom &amp; Jerry's"],
    ["]]><Message>extra</Message>", "]]&gt;&lt;Message&gt;extra&lt;/Message&gt;"],
  ])("escapes %j so it can't add a second message", (text, escaped) => {
    const xml = smsReply(text);
    expect(xml).toBe(`${XML_HEAD}<Response><Message>${escaped}</Message></Response>`);
  });

  it("says nothing at all for an empty reply", () => {
    expect(noSmsReply()).toBe(`${XML_HEAD}<Response/>`);
  });
});
