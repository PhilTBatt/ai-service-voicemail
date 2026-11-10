import { describe, expect, it } from "vitest";
import { e164OrNull, ukMobileFromInput } from "./phone.ts";

describe("e164OrNull", () => {
  it("keeps a real number and drops Twilio's placeholders", () => {
    expect(e164OrNull("+447700900123")).toBe("+447700900123");
    expect(e164OrNull("anonymous")).toBeNull();
    expect(e164OrNull("+266696687")).toBeNull();
    expect(e164OrNull(undefined)).toBeNull();
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
  ])("reads %j as %s", (input, expected) => {
    expect(ukMobileFromInput(input)).toBe(expected);
  });

  it.each(["0113 496 0100", "+441134960100", "7700900123", "+4477009001234", "", undefined])(
    "refuses %j",
    (input) => {
      expect(ukMobileFromInput(input)).toBeNull();
    },
  );
});
