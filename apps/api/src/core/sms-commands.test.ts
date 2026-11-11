import { describe, expect, it } from "vitest";
import { isGsm7 } from "./sms.ts";
import {
  HELP_REPLY,
  HOLIDAY_INVALID_REPLY,
  UNKNOWN_REPLY,
  formatUkDate,
  parseHolidayDate,
  parseSmsCommand,
  ukToday,
} from "./sms-commands.ts";

const TODAY = Temporal.PlainDate.from("2026-07-15");

describe("parseSmsCommand", () => {
  it.each([
    ["OFF", { kind: "off" }],
    ["off", { kind: "off" }],
    [" Off. ", { kind: "off" }],
    ["pause", { kind: "off" }],
    ["ON", { kind: "on" }],
    ["resume!", { kind: "on" }],
    ["STATUS", { kind: "status" }],
    ["HELP", { kind: "help" }],
    ["?", { kind: "help" }],
    ["HOLIDAY 12/12", { kind: "holiday", until: "2026-12-12" }],
    ["holiday 2027-01-05", { kind: "holiday", until: "2027-01-05" }],
    ["Hols 3 Aug", { kind: "holiday", until: "2026-08-03" }],
    ["HOLIDAY", { kind: "holiday-invalid" }],
    ["HOLIDAY tomorrow", { kind: "holiday-invalid" }],
    ["HOLIDAY 31/02", { kind: "holiday-invalid" }],
    ["HOLIDAY 01/01", { kind: "holiday", until: "2027-01-01" }], // already passed this year
    ["Thanks mate", { kind: "unknown" }],
    ["", { kind: "unknown" }],
    ["OFFICE", { kind: "unknown" }],
    // People write questions, and sentences.
    ["Status?", { kind: "status" }],
    ["help?", { kind: "help" }],
    // "till" before the date used to make it unreadable (2026-11-11).
    ["On holiday till 12/12", { kind: "holiday", until: "2026-12-12" }],
    ["On holiday 12/12", { kind: "holiday", until: "2026-12-12" }],
    ["HOLIDAY until 20/12", { kind: "holiday", until: "2026-12-20" }],
    ["holiday till 3 Aug", { kind: "holiday", until: "2026-08-03" }],
    ["Away to 2027-01-05", { kind: "holiday", until: "2027-01-05" }],
    ["hols til 20/12/26", { kind: "holiday", until: "2026-12-20" }],
    ["HOLIDAY UNTIL 20/12.", { kind: "holiday", until: "2026-12-20" }],
    ["HOLIDAY until", { kind: "holiday-invalid" }],
    ["HOLIDAY until tomorrow", { kind: "holiday-invalid" }],
    ["HOLIDAY until 10/07/2026", { kind: "holiday-invalid" }], // already over
    ["HOLIDAY until until 20/12", { kind: "holiday-invalid" }],
    ["on hols 3 Aug", { kind: "holiday", until: "2026-08-03" }],
    // ON and OFF with more after them aren't guessed at: the reply lists the commands.
    ["Off sick till Monday", { kind: "unknown" }],
    ["On my way", { kind: "unknown" }],
  ])("parses %j", (body, expected) => {
    expect(parseSmsCommand(body, TODAY)).toEqual(expected);
  });
});

describe("parseHolidayDate", () => {
  it.each([
    ["2026-12-12", "2026-12-12"],
    ["12/12/2026", "2026-12-12"],
    ["12/12/26", "2026-12-12"],
    ["12.12.26", "2026-12-12"],
    ["12-12", "2026-12-12"],
    ["15/07", "2026-07-15"], // today counts
    ["14/07", "2027-07-14"], // yesterday means next year
    ["29/02", "2028-02-29"], // next leap day
    ["1st Sept", "2026-09-01"],
    ["25 December 2026", "2026-12-25"],
  ])("reads %s as %s", (text, iso) => {
    expect(parseHolidayDate(text, TODAY)).toBe(iso);
  });

  it.each(["", "soon", "32/01", "12/13", "2025-01-01", "12/12/2025", "5 Octember"])(
    "rejects %s",
    (text) => {
      expect(parseHolidayDate(text, TODAY)).toBeNull();
    },
  );

  it.each([
    ["until 12/12", "2026-12-12"],
    ["till 14/07", "2027-07-14"], // yesterday means next year, as without the word
    ["to 1st Sept", "2026-09-01"],
  ])("reads %s as %s", (text, iso) => {
    expect(parseHolidayDate(text, TODAY)).toBe(iso);
  });

  it.each(["until", "until 2025-01-01", "untill 12/12", "tomorrow 12/12"])("rejects %s", (text) => {
    expect(parseHolidayDate(text, TODAY)).toBeNull();
  });
});

describe("HOLIDAY until a date, around UK midnight and the year's end", () => {
  const at = (iso: string) => ukToday(new Date(iso));

  it.each([
    // 23:30 UTC on 31 December is still New Year's Eve in the UK (GMT).
    ["2026-12-31T23:30:00Z", "HOLIDAY until 31/12", "2026-12-31"],
    ["2026-12-31T23:30:00Z", "HOLIDAY until 2/1", "2027-01-02"],
    ["2026-12-31T23:30:00Z", "HOLIDAY till 20/12", "2027-12-20"], // gone this year
    ["2027-01-01T00:30:00Z", "away to 31/12", "2027-12-31"],
    // 23:30 UTC on 15 July is 00:30 on the 16th in the UK (BST): the 15th has gone.
    ["2026-07-15T23:30:00Z", "HOLIDAY until 15/07", "2027-07-15"],
    ["2026-07-15T23:30:00Z", "HOLIDAY until 16/07", "2026-07-16"],
  ])("at %s reads %j as %s", (now, body, until) => {
    expect(parseSmsCommand(body, at(now))).toEqual({ kind: "holiday", until });
  });

  it("refuses a date with a year that has already gone, at the turn of the year", () => {
    expect(parseSmsCommand("HOLIDAY until 31/12/2026", at("2027-01-01T00:30:00Z"))).toEqual({
      kind: "holiday-invalid",
    });
  });
});

describe("ukToday", () => {
  it("uses the UK date, not UTC", () => {
    // 23:30 UTC on 14 July is 00:30 BST on 15 July.
    expect(ukToday(new Date("2026-07-14T23:30:00Z")).toString()).toBe("2026-07-15");
    expect(ukToday(new Date("2026-01-14T23:30:00Z")).toString()).toBe("2026-01-14");
  });
});

describe("replies", () => {
  it("formats dates the British way", () => {
    expect(formatUkDate("2026-12-12")).toBe("12 Dec 2026");
  });

  it("are plain GSM-7 text", () => {
    for (const reply of [HELP_REPLY, UNKNOWN_REPLY, HOLIDAY_INVALID_REPLY]) {
      expect(isGsm7(reply)).toBe(true);
      expect(reply.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("opt-out keywords", () => {
  it("doesn't treat STOP or START as commands, since carriers reserve them", () => {
    expect(parseSmsCommand("STOP", TODAY)).toEqual({ kind: "unknown" });
    expect(parseSmsCommand("START", TODAY)).toEqual({ kind: "unknown" });
  });
});
