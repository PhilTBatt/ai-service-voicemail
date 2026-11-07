import { describe, expect, it } from "vitest";
import { isGsm7 } from "./sms.ts";
import {
  callSms,
  emergencyCallerSms,
  emergencyTradespersonSms,
  nationalNumber,
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
