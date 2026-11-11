import { describe, expect, it } from "vitest";
import { isGsm7 } from "./sms.ts";
import {
  callEmail,
  callSms,
  emergencyCallerSms,
  emergencyTradespersonSms,
  escapeHtml,
  formatUkDateTime,
  nationalNumber,
  voicemailEmail,
  voicemailSms,
  type CallEmailInput,
  type CallNotificationInput,
} from "./notifications.ts";

const INPUT: CallNotificationInput = {
  urgency: "urgent",
  callerName: "Sam",
  callbackNumber: "+447700900123",
  postcode: "XQ12 3JL",
  summary: "Boiler leaking under the kitchen sink; no hot water.\nWants someone today if possible.",
  callUrl: "https://callmate.example.com/c/abc123.1799999999.sig",
};

describe("callSms", () => {
  it("matches the agreed wording", () => {
    expect(callSms(INPUT)).toMatchSnapshot();
  });

  it("puts urgency, who, the summary, a tel: link and the call link on their own lines", () => {
    const { body } = callSms(INPUT);
    expect(body.split("\n")).toEqual([
      "URGENT: Sam, 07700 900123, XQ12 3JL",
      "Boiler leaking under the kitchen sink; no hot water. Wants someone today if possible.",
      "Call back: tel:+447700900123",
      "Details: https://callmate.example.com/c/abc123.1799999999.sig",
    ]);
  });

  it("stays in GSM-7 and within two segments for a typical call", () => {
    const { body, segments } = callSms(INPUT);
    expect(isGsm7(body)).toBe(true);
    expect(segments).toBeLessThanOrEqual(2);
  });

  it("normalises an LLM summary with curly quotes and an emoji so the text isn't sent as UCS-2", () => {
    const { body } = callSms({ ...INPUT, summary: "Caller said “it’s urgent” — boiler \u{1F525}" });
    expect(isGsm7(body)).toBe(true);
    expect(body).toContain('Caller said "it\'s urgent" - boiler');
  });

  it("copes with a withheld number and no name or postcode", () => {
    const { body } = callSms({ ...INPUT, callerName: null, callbackNumber: null, postcode: null });
    expect(body.split("\n")[0]).toBe("URGENT: number withheld");
    expect(body).not.toContain("tel:");
  });

  it.each([
    ["emergency", "EMERGENCY:"],
    ["routine", "New enquiry:"],
    ["spam", "Possible spam:"],
    [null, "Call:"],
  ] as const)("labels urgency %s as %s", (urgency, label) => {
    expect(callSms({ ...INPUT, urgency }).body.startsWith(label)).toBe(true);
  });

  it("keeps only the first two lines of a long summary", () => {
    const { body } = callSms({ ...INPUT, summary: "One.\nTwo.\nThree." });
    expect(body.split("\n")[1]).toBe("One. Two.");
  });
});

describe("nationalNumber", () => {
  it("formats UK mobiles and leaves others alone", () => {
    expect(nationalNumber("+447700900123")).toBe("07700 900123");
    expect(nationalNumber("+12025550143")).toBe("+12025550143");
  });
});

describe("emergency texts", () => {
  it("match the agreed wording", () => {
    expect(emergencyTradespersonSms({ callbackNumber: "+447700900123" })).toMatchSnapshot();
    expect(emergencyTradespersonSms({ callbackNumber: null })).toMatchSnapshot();
    expect(emergencyCallerSms({ businessName: "Gas Plumbing", region: "GB" })).toMatchSnapshot();
    expect(emergencyCallerSms({ businessName: "Gas Plumbing", region: "NI" })).toMatchSnapshot();
  });

  it("are GSM-7 and fit one segment for a typical business name", () => {
    const tradesperson = emergencyTradespersonSms({ callbackNumber: "+447700900123" });
    const caller = emergencyCallerSms({ businessName: "Gas Plumbing", region: "GB" });
    for (const text of [tradesperson, caller]) {
      expect(isGsm7(text.body)).toBe(true);
      expect(text.segments).toBe(1);
    }
    // A long name costs a second segment, never a third.
    expect(
      emergencyCallerSms({ businessName: "Battersby & Brockway Heating Services", region: "GB" })
        .segments,
    ).toBe(2);
  });
});

describe("voicemailSms", () => {
  const input = { callbackNumber: "+447700900123", durationSeconds: 42, callUrl: INPUT.callUrl };

  it("matches the agreed wording", () => {
    expect(voicemailSms(input)).toMatchSnapshot();
    expect(voicemailSms({ ...input, callbackNumber: null })).toMatchSnapshot();
  });

  it("names the caller's number, or says it was withheld, and links to the recording", () => {
    expect(voicemailSms(input).body.split("\n")).toEqual([
      "New voicemail (42 sec) from 07700 900123. The assistant wasn't available, so the caller left a message.",
      "Call back: tel:+447700900123",
      `Listen: ${INPUT.callUrl}`,
    ]);
    const withheld = voicemailSms({ ...input, callbackNumber: null }).body;
    expect(withheld).toContain("from a withheld number");
    expect(withheld).not.toContain("tel:");
    expect(isGsm7(withheld)).toBe(true);
  });
});

const EMAIL_INPUT: CallEmailInput = {
  ...INPUT,
  businessName: "Extract Plumbing",
  startedAt: new Date("2026-07-15T08:00:00Z"), // 09:00 BST
  flags: ["mentioned gas smell"],
  transcript: [
    { role: "agent", text: "Hi, you're through to Extract Plumbing. How can I help?" },
    { role: "caller", text: "It's Sam, my boiler's leaking <badly> & I can smell gas." },
  ],
  recordingUrl: `${INPUT.callUrl}/recording`,
};

describe("callEmail", () => {
  it("shows the number the call came from too, when the caller gave a different one", () => {
    const { text, html } = callEmail({ ...EMAIL_INPUT, callerId: "+441134960999" });
    expect(text).toContain("Rang from: 01134 960999 (tel:+441134960999)");
    expect(html).toContain("Rang from");
    // The same number twice says nothing new.
    const same = callEmail({ ...EMAIL_INPUT, callerId: EMAIL_INPUT.callbackNumber });
    expect(same.text).not.toContain("Rang from");
  });

  it("matches the agreed wording", () => {
    expect(callEmail(EMAIL_INPUT)).toMatchSnapshot();
  });

  it("puts the urgency, who and the first summary line in the subject", () => {
    expect(callEmail(EMAIL_INPUT).subject).toBe(
      "URGENT: Sam, 07700 900123 - Boiler leaking under the kitchen sink; no hot water.",
    );
    expect(callEmail({ ...EMAIL_INPUT, callerName: null, callbackNumber: null }).subject).toBe(
      "URGENT: Unknown caller, number withheld - Boiler leaking under the kitchen sink; no hot water.",
    );
  });

  it("escapes caller-supplied text in the HTML and keeps it readable in the text version", () => {
    const { text, html } = callEmail(EMAIL_INPUT);
    expect(html).toContain("leaking &lt;badly&gt; &amp; I can smell gas.");
    expect(html).not.toContain("<badly>");
    expect(text).toContain("Caller: It's Sam, my boiler's leaking <badly> & I can smell gas.");
  });

  it("shows UK time, the links, and copes with a cleared transcript", () => {
    const { text, html } = callEmail({ ...EMAIL_INPUT, transcript: null, recordingUrl: null });
    expect(text).toContain("Wednesday 15 July 2026, 09:00");
    expect(text).toContain(`Call page: ${INPUT.callUrl}`);
    expect(text).not.toContain("Recording:");
    expect(text).toContain("(no longer available)");
    expect(html).toContain("Open the call page");
    expect(html).not.toContain("Listen to the recording");
  });
});

describe("voicemailEmail", () => {
  it("matches the agreed wording", () => {
    expect(
      voicemailEmail({
        businessName: "Extract Plumbing",
        startedAt: new Date("2026-01-15T08:00:00Z"), // 08:00 GMT
        callbackNumber: "+447700900123",
        durationSeconds: 42,
        callUrl: INPUT.callUrl,
        recordingUrl: `${INPUT.callUrl}/recording`,
      }),
    ).toMatchSnapshot();
  });
});

describe("email helpers", () => {
  it("formats UK time on both sides of the clock change", () => {
    expect(formatUkDateTime(new Date("2026-07-15T08:00:00Z"))).toBe(
      "Wednesday 15 July 2026, 09:00",
    );
    expect(formatUkDateTime(new Date("2026-01-15T08:05:00Z"))).toBe(
      "Thursday 15 January 2026, 08:05",
    );
  });

  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });
});

describe("callSms length", () => {
  it("cuts a long summary so the text never runs past two segments", () => {
    const longSummary = Array.from(
      { length: 30 },
      (_, i) => `Detail number ${i} about the job`,
    ).join(" ");
    const { body, segments } = callSms({ ...INPUT, summary: longSummary });
    expect(segments).toBeLessThanOrEqual(2);
    expect(body).toContain("...");
    expect(body).toContain("Call back: tel:+447700900123");
    expect(body).toContain(`Details: ${INPUT.callUrl}`);
  });
});
