// Edge cases for the texts a tradesperson sends (sms-commands.ts): punctuation, case, words a
// phone's keyboard adds, carriers' own keywords, and dates around UK midnight and leap years.
import { describe, expect, it } from "vitest";
import { parseHolidayDate, parseSmsCommand, ukToday, type SmsCommand } from "./sms-commands.ts";

const TODAY = Temporal.PlainDate.from("2026-11-11");

describe("parseSmsCommand, how people actually type", () => {
  it.each<[string, SmsCommand]>([
    ["off", { kind: "off" }],
    ["  OFF  ", { kind: "off" }],
    ["Off!!!", { kind: "off" }],
    ["off.\n", { kind: "off" }],
    ["pause", { kind: "off" }],
    ["On", { kind: "on" }],
    ["resume!", { kind: "on" }],
    ["STATUS?", { kind: "status" }],
    ["status please", { kind: "status" }],
    ["Help", { kind: "help" }],
    ["?", { kind: "help" }],
    ["  ?  ", { kind: "help" }],
    ["away 25/12", { kind: "holiday", until: "2026-12-25" }],
    ["HOLS  25 Dec", { kind: "holiday", until: "2026-12-25" }],
    ["holiday 1st January", { kind: "holiday", until: "2027-01-01" }],
    ["On away 25/12", { kind: "holiday", until: "2026-12-25" }],
  ])("reads %j", (body, want) => {
    expect(parseSmsCommand(body, TODAY)).toEqual(want);
  });

  it.each([
    // Anything more than the bare word is a guess too far for a switch (sms-commands.ts).
    ["off sick till Monday", "unknown"],
    ["OFF OFF", "unknown"],
    ["on it", "unknown"],
    ["o f f", "unknown"],
    // Carriers' and Twilio's own keywords are theirs, never ours.
    ["STOP", "unknown"],
    ["START", "unknown"],
    ["UNSTOP", "unknown"],
    // Look-alikes: full-width letters, a Cyrillic O.
    ["ＯＦＦ", "unknown"],
    ["ОFF", "unknown"],
    ["", "unknown"],
    ["   ", "unknown"],
    ["!!!", "unknown"],
    ["\u{1F44D}", "unknown"],
    ["<script>alert(1)</script>", "unknown"],
    // A holiday with a date it can't read asks again rather than guessing.
    ["holiday", "holiday-invalid"],
    ["holiday soon", "holiday-invalid"],
    ["holiday 31/11", "holiday-invalid"],
    ["holiday 10/11/2026", "holiday-invalid"], // yesterday
  ])("reads %j as %s", (body, kind) => {
    expect(parseSmsCommand(body, TODAY).kind).toBe(kind);
  });

  it("reads a long text without choking on it", () => {
    expect(parseSmsCommand(`status ${"x".repeat(10_000)}`, TODAY)).toEqual({ kind: "status" });
    expect(parseSmsCommand("off ".repeat(2_000), TODAY)).toEqual({ kind: "unknown" });
  });
});

describe("parseHolidayDate", () => {
  it.each([
    ["11/11", "2026-11-11"], // today still counts: the holiday is today
    ["10/11", "2027-11-10"], // passed this year: next year's
    ["12/12/26", "2026-12-12"],
    ["12.12.2026", "2026-12-12"],
    ["12-12-2026", "2026-12-12"],
    ["2026-12-12", "2026-12-12"],
    ["2027-1-5", "2027-01-05"],
    ["29/02", "2028-02-29"], // the next 29 February
    ["29 feb", "2028-02-29"],
    ["12 sept", "2027-09-12"],
    ["3rd Dec", "2026-12-03"],
  ])("reads %j as %s", (text, want) => {
    expect(parseHolidayDate(text, TODAY)).toBe(want);
  });

  it.each([
    "29/02/2027", // not a leap year
    "31/04",
    "00/12",
    "12/00",
    "32 Dec",
    "12/13",
    "2026-13-01",
    "2026-11-10", // yesterday
    "12/12/2025",
    "12 Smarch",
    "sept 12", // month first isn't read: 12/09 and 09/12 are too easily confused
    "12/12/2026/1",
    "1e3/12",
  ])("refuses %j", (text) => {
    expect(parseHolidayDate(text, TODAY)).toBeNull();
  });
});

describe("ukToday at midnight", () => {
  it.each([
    // In BST, the UK date turns over at 23:00 UTC.
    ["2026-07-15T22:59:59Z", "2026-07-15"],
    ["2026-07-15T23:00:00Z", "2026-07-16"],
    // In GMT, at midnight UTC.
    ["2026-12-31T23:59:59Z", "2026-12-31"],
    ["2027-01-01T00:00:00Z", "2027-01-01"],
    // On the clock-change Sundays.
    ["2026-03-29T00:30:00Z", "2026-03-29"],
    ["2026-10-24T23:30:00Z", "2026-10-25"],
  ])("at %s the UK date is %s", (iso, date) => {
    expect(ukToday(new Date(iso)).toString()).toBe(date);
  });

  it("reads '15/07' sent at 00:30 BST on 16 July as next year's, since the 15th has gone", () => {
    const today = ukToday(new Date("2026-07-15T23:30:00Z"));
    expect(parseSmsCommand("HOLIDAY 15/07", today)).toEqual({
      kind: "holiday",
      until: "2027-07-15",
    });
  });

  it("reads '31/12' sent late on New Year's Eve as that same night", () => {
    const today = ukToday(new Date("2026-12-31T23:30:00Z"));
    expect(parseSmsCommand("HOLIDAY 31/12", today)).toEqual({
      kind: "holiday",
      until: "2026-12-31",
    });
  });
});
