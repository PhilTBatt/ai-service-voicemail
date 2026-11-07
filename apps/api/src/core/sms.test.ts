import { describe, expect, it } from "vitest";
import { isGsm7, smsEncoding, toGsm7 } from "./sms.ts";

describe("smsEncoding", () => {
  it("sends plain text as GSM-7, one segment up to 160 characters", () => {
    expect(smsEncoding("a".repeat(160))).toEqual({ encoding: "GSM-7", segments: 1 });
    expect(smsEncoding("a".repeat(161))).toEqual({ encoding: "GSM-7", segments: 2 });
    expect(smsEncoding("a".repeat(306))).toEqual({ encoding: "GSM-7", segments: 2 });
    expect(smsEncoding("a".repeat(307))).toEqual({ encoding: "GSM-7", segments: 3 });
  });

  it("counts GSM-7 extension characters twice", () => {
    // 159 letters plus a € (2 septets) is 161: two segments.
    expect(smsEncoding("a".repeat(159) + "€")).toEqual({ encoding: "GSM-7", segments: 2 });
  });

  it.each(["Boiler's leaking 😬", "He said “hello”", "Call back — urgent"])(
    "switches to UCS-2 (70 per segment) for %s",
    (text) => {
      expect(smsEncoding(text).encoding).toBe("UCS-2");
      expect(smsEncoding(text + "a".repeat(70)).segments).toBe(2);
    },
  );

  it("keeps £ and the UK number characters in GSM-7", () => {
    expect(isGsm7("Call back: tel:+447700900123 (£ not quoted)")).toBe(true);
  });
});

describe("toGsm7", () => {
  it("replaces curly quotes, dashes and ellipses with plain ones", () => {
    expect(toGsm7("He said “it’s — fine…”")).toBe('He said "it\'s - fine..."');
  });

  it("strips accents it can't carry and drops emoji", () => {
    expect(toGsm7("Café Zoë 😬 done")).toBe("Café Zoe  done");
  });

  it("leaves a GSM-7 text untouched", () => {
    const text = "URGENT: Sam, 07700 900123, XQ12 3JL\nBoiler leaking.";
    expect(toGsm7(text)).toBe(text);
    expect(isGsm7(toGsm7("Ünïcödé — “quotes” 🚀"))).toBe(true);
  });
});

describe("GSM-7 edge cases", () => {
  it("counts UCS-2 in 16-bit units, so an emoji outside the basic plane costs two", () => {
    // 69 letters plus one emoji (two UTF-16 units) is 71 units: two segments.
    expect(smsEncoding("a".repeat(69) + "\u{1F525}").segments).toBe(2);
  });

  it("treats the ESC prefix as unsendable and drops it", () => {
    expect(isGsm7("\u001b")).toBe(false);
    expect(toGsm7("a\u001bb")).toBe("ab");
  });
});
