// Edge cases for reading phone numbers: what Twilio, Retell, a person or the extraction might
// send. A wrong "yes" here texts the wrong person or prints a broken tel: link; a wrong "no"
// loses a call-back number. Drama-range numbers only (CLAUDE.md rule 3).
import { describe, expect, it } from "vitest";
import { e164OrNull, phoneFromInput, ukMobileFromInput } from "./phone.ts";

describe("e164OrNull", () => {
  it.each([
    ["+447700900123", "+447700900123"],
    ["+441134960000", "+441134960000"],
    ["+12345678", "+12345678"], // the shortest E.164 the database's domain accepts: 8 digits
    ["+123456789012345", "+123456789012345"], // and the longest: 15
  ])("keeps %j", (given, want) => {
    expect(e164OrNull(given)).toBe(want);
  });

  it.each([
    ["Twilio's withheld placeholder", "+266696687"],
    ["the word Twilio sends", "anonymous"],
    ["an empty From", ""],
    ["a national number", "07700900123"],
    ["no plus", "447700900123"],
    ["a leading zero after the plus", "+0447700900123"],
    ["seven digits", "+1234567"],
    ["sixteen digits", "+1234567890123456"],
    ["spaces", "+44 7700 900123"],
    ["a trailing newline", "+447700900123\n"],
    ["a trailing space", "+447700900123 "],
    ["two numbers", "+447700900123,+447700900124"],
    ["Arabic-Indic digits", "+٤٤٧٧٠٠٩٠٠١٢٣"],
    ["full-width digits", "+４４７７００９００１２３"],
    ["SQL", "+447700900123'; DROP TABLE calls;--"],
  ])("refuses %s", (_what, given) => {
    expect(e164OrNull(given)).toBeNull();
  });

  it("refuses null and undefined", () => {
    expect(e164OrNull(null)).toBeNull();
    expect(e164OrNull(undefined)).toBeNull();
  });
});

describe("ukMobileFromInput", () => {
  it.each([
    ["07700.900.123", "+447700900123"],
    ["(07700) 900123", "+447700900123"],
    ["+44 07700 900123", "+447700900123"],
    ["+44 (0) 7700 900 123", "+447700900123"],
    ["07700 900123", "+447700900123"], // a non-breaking space, as pasted from a web page
    ["\t07700 900 000 ", "+447700900000"],
    ["07700 900999", "+447700900999"],
  ])("reads %j as %s", (given, want) => {
    expect(ukMobileFromInput(given)).toBe(want);
  });

  it.each([
    ["a Leeds landline", "0113 496 0000"],
    ["a drama-range landline", "01632 960123"],
    ["one digit short", "07700 90012"],
    ["one digit over", "07700 9001234"],
    ["an extension", "07700 900123 ext 2"],
    ["letters for digits", "07700 9OO123"],
    ["a mobile with a plus but no country", "+07700900123"],
    ["just the country code", "+44"],
  ])("refuses %s", (_what, given) => {
    expect(ukMobileFromInput(given)).toBeNull();
  });
});

describe("phoneFromInput", () => {
  it.each([
    ["0044 (0)7700 900123", "+447700900123"],
    ["0044 (0)113 496 0000", "+441134960000"],
    ["+44 (0)113 496 0000", "+441134960000"],
    ["441134960000", "+441134960000"],
    ["4407700900123", "+447700900123"],
    ["01632 960123", "+441632960123"],
    ["  +44 7700-900-123  ", "+447700900123"],
    ["(0113) 496-0000", "+441134960000"],
    ["7700900123", "+447700900123"],
    ["+447700900123", "+447700900123"],
  ])("reads %j as %s", (given, want) => {
    expect(phoneFromInput(given)).toBe(want);
  });

  it.each([
    ["a mobile one digit short", "07700 90012"],
    ["a mobile one digit over", "077009001234"],
    ["a UK number far too long", "0113 496 0000 0000"],
    ["two numbers", "07700 900123 or 07700 900124"],
    ["words", "the number I'm calling from"],
    ["Twilio's withheld placeholder", "+266696687"],
    ["just a plus", "+"],
    ["just zeros", "0000000000"],
    ["a 'tel:' link", "tel:+447700900123"],
  ])("refuses %s", (_what, given) => {
    expect(phoneFromInput(given)).toBeNull();
  });

  it("only ever answers E.164 the database will take, for any of these", () => {
    const e164 = /^\+[1-9]\d{7,14}$/; // the e164_phone domain's own check
    for (const given of [
      "07700 900123",
      "0044 (0)7700 900123",
      "+44 (0)113 496 0000",
      "7700900123",
      "0",
      "00",
      "+440",
      "440",
      "-",
      "()",
    ]) {
      const read = phoneFromInput(given);
      if (read !== null) expect(read, given).toMatch(e164);
    }
  });
});
