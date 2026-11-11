import { describe, expect, it } from "vitest";
import { e164OrNull, phoneFromInput, ukMobileFromInput } from "./phone.ts";

describe("e164OrNull", () => {
  it("keeps a real number and drops Twilio's placeholders", () => {
    expect(e164OrNull("+447700900123")).toBe("+447700900123");
    expect(e164OrNull("anonymous")).toBeNull();
    expect(e164OrNull("+266696687")).toBeNull();
    // RESTRICTED, UNAVAILABLE and BLOCKED on a keypad, the same kind of placeholder.
    expect(e164OrNull("+7378742833")).toBeNull();
    expect(e164OrNull("+86282452253")).toBeNull();
    expect(e164OrNull("+2562533")).toBeNull();
    expect(e164OrNull(undefined)).toBeNull();
    // Retell's withheld callers come as "" or null; neither may reach the database as a number.
    expect(e164OrNull("")).toBeNull();
    expect(e164OrNull(null)).toBeNull();
    // Only the exact form: a space or a national number would break the e164_phone column.
    expect(e164OrNull("+44 7700 900123")).toBeNull();
    expect(e164OrNull("07700900123")).toBeNull();
  });
});

describe("ukMobileFromInput", () => {
  it.each([
    ["+447700900123", "+447700900123"],
    ["07700 900123", "+447700900123"],
    ["07700-900-123", "+447700900123"],
    ["+44 (0)7700 900123", "+447700900123"],
    ["+44 7700 900123", "+447700900123"],
    ["447700900123", "+447700900123"],
    [" 07700900123\n", "+447700900123"],
    // 00 for the +, as phoneFromInput reads it: these used to be refused.
    ["0044 7700 900123", "+447700900123"],
    ["0044 (0)7700 900123", "+447700900123"],
    ["00447700900123", "+447700900123"],
  ])("reads %j as %s", (input, expected) => {
    expect(ukMobileFromInput(input)).toBe(expected);
  });

  it("reads every UK mobile the way phoneFromInput does", () => {
    for (const given of ["0044 7700 900123", "0044 (0)7700 900123", "+44 (0)7700 900123"]) {
      expect(ukMobileFromInput(given), given).toBe(phoneFromInput(given));
    }
  });

  it.each([
    "0113 496 0100",
    "+441134960100",
    "7700900123",
    "+4477009001234",
    "",
    undefined,
    // Another country's number (a US fictional 555-01xx one), or a UK landline, written with 00
    "001 202 555 0143",
    "0044 113 496 0100",
    "00 7700 900123",
  ])("refuses %j", (input) => {
    expect(ukMobileFromInput(input)).toBeNull();
  });
});

describe("phoneFromInput", () => {
  it("reads a number however the extraction wrote it, mobile or landline", () => {
    for (const [given, want] of [
      ["+44 7700 900123", "+447700900123"],
      ["07700 900123", "+447700900123"],
      ["+44 (0)7700-900123", "+447700900123"],
      ["0113 496 0000", "+441134960000"],
      ["0044 7700 900123", "+447700900123"],
      ["7700 900123", "+447700900123"],
    ]) {
      expect(phoneFromInput(given), given).toBe(want);
    }
  });

  it("gives null for anything that isn't a number, so the caller ID is used instead", () => {
    for (const given of ["", "unknown", "0 7700", "07700 90012", "077009001234", null, undefined]) {
      expect(phoneFromInput(given), String(given)).toBeNull();
    }
  });
});
