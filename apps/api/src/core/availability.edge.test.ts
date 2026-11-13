// Opening hours and holidays at the edges of the UK day: the clock-change weekends (2026: forward
// at 01:00 UTC on Sunday 29 March, back at 01:00 UTC on Sunday 25 October), midnight in BST,
// and the last second of a holiday. CLAUDE.md asks for the clock-change weekends to be tested.
import { describe, expect, it } from "vitest";
import {
  holidayUntilWords,
  isOnHolidayAt,
  isOpenAt,
  perCallVariables,
  startOfUkDay,
} from "./availability.ts";
import type { OpeningHours } from "./profile.ts";

const at = (iso: string) => new Date(iso);

// Overnight hours (the watch list, 2026-11-13): a slot that closes earlier than it opens runs
// into the next morning, so the hours after midnight belong to the day before.
describe("isOpenAt with overnight hours", () => {
  const lateNights: OpeningHours = {
    fri: { open: "18:00", close: "02:00" },
    sun: { open: "20:00", close: "06:00" }, // into Monday: the week wraps
  };

  it.each([
    // Friday 17 July 2026 is BST: 18:00 UK is 17:00 UTC.
    ["Friday 17:59", "2026-07-17T16:59:00Z", false],
    ["Friday 18:00", "2026-07-17T17:00:00Z", true],
    ["Friday 23:59", "2026-07-17T22:59:00Z", true],
    ["Saturday 00:00", "2026-07-17T23:00:00Z", true],
    ["Saturday 01:59", "2026-07-18T00:59:00Z", true],
    ["Saturday 02:00 (close is exclusive)", "2026-07-18T01:00:00Z", false],
    ["Saturday 18:00 (Saturday is closed)", "2026-07-18T17:00:00Z", false],
    ["Sunday 19:59", "2026-07-19T18:59:00Z", false],
    ["Sunday 22:00", "2026-07-19T21:00:00Z", true],
    ["Monday 05:59, from Sunday's slot", "2026-07-20T04:59:00Z", true],
    ["Monday 06:00", "2026-07-20T05:00:00Z", false],
  ])("%s: %s", (_label, iso, open) => {
    expect(isOpenAt(lateNights, at(iso))).toBe(open);
  });

  it("keeps the same wall-clock hours across both clock changes", () => {
    // Saturday 28 March 2027 18:00 to 02:00: the clocks go forward at 01:00 UTC on Sunday 29th,
    // so 01:00 to 02:00 UK doesn't exist, and 02:00 BST (01:00 UTC) is closing time.
    const saturdayNight: OpeningHours = { sat: { open: "18:00", close: "02:00" } };
    expect(isOpenAt(saturdayNight, at("2027-03-27T18:00:00Z"))).toBe(true); // 18:00 GMT
    expect(isOpenAt(saturdayNight, at("2027-03-28T00:59:00Z"))).toBe(true); // 00:59 GMT
    expect(isOpenAt(saturdayNight, at("2027-03-28T01:00:00Z"))).toBe(false); // 02:00 BST
    // Saturday 24 October 2026 18:00 to 02:00: the clocks go back at 01:00 UTC on Sunday 25th,
    // so 01:00 to 02:00 UK happens twice, and both are inside the slot.
    expect(isOpenAt(saturdayNight, at("2026-10-24T23:30:00Z"))).toBe(true); // 00:30 BST
    expect(isOpenAt(saturdayNight, at("2026-10-25T00:30:00Z"))).toBe(true); // 01:30 BST
    expect(isOpenAt(saturdayNight, at("2026-10-25T01:30:00Z"))).toBe(true); // 01:30 GMT
    expect(isOpenAt(saturdayNight, at("2026-10-25T02:00:00Z"))).toBe(false); // 02:00 GMT
  });

  it("opens all of a day with 00:00 to 23:59, the way the editor suggests", () => {
    const allDay: OpeningHours = { wed: { open: "00:00", close: "23:59" } };
    expect(isOpenAt(allDay, at("2026-07-14T23:00:00Z"))).toBe(true); // Wednesday 00:00 BST
    expect(isOpenAt(allDay, at("2026-07-15T22:58:00Z"))).toBe(true); // Wednesday 23:58 BST
    expect(isOpenAt(allDay, at("2026-07-15T22:59:00Z"))).toBe(false); // the last minute
  });
});

describe("isOpenAt around the clock changes", () => {
  const weekdays: OpeningHours = {
    mon: { open: "08:00", close: "18:00" },
    sat: { open: "09:00", close: "12:00" },
    sun: { open: "01:00", close: "03:00" },
  };

  it.each([
    // The Saturday before the spring change is GMT: 09:00 UK is 09:00 UTC.
    ["2026-03-28T08:59:59Z", false],
    ["2026-03-28T09:00:00Z", true],
    ["2026-03-28T11:59:59Z", true],
    ["2026-03-28T12:00:00Z", false],
    // Spring Sunday: 01:00 to 02:00 UK doesn't exist. 00:59 UTC is 00:59 GMT, closed;
    // 01:00 UTC is already 02:00 BST, open; 02:00 UTC is 03:00 BST, closed.
    ["2026-03-29T00:59:59Z", false],
    ["2026-03-29T01:00:00Z", true],
    ["2026-03-29T01:59:59Z", true],
    ["2026-03-29T02:00:00Z", false],
    // The Monday after is BST: 08:00 UK is 07:00 UTC.
    ["2026-03-30T06:59:59Z", false],
    ["2026-03-30T07:00:00Z", true],
    ["2026-03-30T16:59:59Z", true],
    ["2026-03-30T17:00:00Z", false],
    // Autumn Sunday: 01:00 to 02:00 UK happens twice, and both are inside the slot.
    ["2026-10-25T00:00:00Z", true], // 01:00 BST
    ["2026-10-25T00:59:59Z", true], // 01:59 BST
    ["2026-10-25T01:00:00Z", true], // 01:00 GMT, the second time round
    ["2026-10-25T01:59:59Z", true], // 01:59 GMT
    ["2026-10-25T02:59:59Z", true], // 02:59 GMT
    ["2026-10-25T03:00:00Z", false], // 03:00 GMT
    // The Monday after is GMT again: 08:00 UK is 08:00 UTC.
    ["2026-10-26T07:59:59Z", false],
    ["2026-10-26T08:00:00Z", true],
    ["2026-10-26T17:59:59Z", true],
    ["2026-10-26T18:00:00Z", false],
  ])("at %s, open is %s", (iso, open) => {
    expect(isOpenAt(weekdays, at(iso))).toBe(open);
  });

  it("reads the autumn Sunday's second 01:xx as inside a 02:00-03:00 slot only once it's 02:00 GMT", () => {
    const hours: OpeningHours = { sun: { open: "02:00", close: "03:00" } };
    expect(isOpenAt(hours, at("2026-10-25T00:30:00Z"))).toBe(false); // 01:30 BST
    expect(isOpenAt(hours, at("2026-10-25T01:30:00Z"))).toBe(false); // 01:30 GMT
    expect(isOpenAt(hours, at("2026-10-25T02:00:00Z"))).toBe(true); // 02:00 GMT
  });

  it("uses the UK day for a call just after midnight in BST, when UTC is still on yesterday", () => {
    const hours: OpeningHours = { thu: { open: "00:00", close: "01:00" } };
    // 23:30 UTC on Wednesday 15 July is 00:30 BST on Thursday 16 July.
    expect(isOpenAt(hours, at("2026-07-15T23:30:00Z"))).toBe(true);
    expect(isOpenAt(hours, at("2026-07-15T22:59:59Z"))).toBe(false);
  });

  it("is closed at the slot's last minute boundary: close is exclusive, open inclusive", () => {
    const hours: OpeningHours = { wed: { open: "08:00", close: "08:01" } };
    expect(isOpenAt(hours, at("2026-01-14T08:00:00Z"))).toBe(true);
    expect(isOpenAt(hours, at("2026-01-14T08:00:59Z"))).toBe(true);
    expect(isOpenAt(hours, at("2026-01-14T08:01:00Z"))).toBe(false);
  });
});

describe("isOnHolidayAt, the last second of the last day", () => {
  it.each([
    // Summer (BST): the day ends at 23:00 UTC.
    ["2026-07-15", "2026-07-15T22:59:59Z", true],
    ["2026-07-15", "2026-07-15T23:00:00Z", false],
    // Winter (GMT): the day ends at midnight UTC.
    ["2026-12-20", "2026-12-20T23:59:59Z", true],
    ["2026-12-20", "2026-12-21T00:00:00Z", false],
    // Ending on the spring Sunday (a 23-hour day, which ends in BST).
    ["2026-03-29", "2026-03-29T22:59:59Z", true],
    ["2026-03-29", "2026-03-29T23:00:00Z", false],
    // Ending the Saturday before it (GMT all day).
    ["2026-03-28", "2026-03-28T23:59:59Z", true],
    ["2026-03-28", "2026-03-29T00:00:00Z", false],
    // Ending on the autumn Sunday (a 25-hour day, which ends in GMT).
    ["2026-10-25", "2026-10-25T23:59:59Z", true],
    ["2026-10-25", "2026-10-26T00:00:00Z", false],
    // Ending the Saturday before it (BST all day).
    ["2026-10-24", "2026-10-24T22:59:59Z", true],
    ["2026-10-24", "2026-10-24T23:00:00Z", false],
    // A leap day.
    ["2028-02-29", "2028-02-29T23:59:59Z", true],
    ["2028-02-29", "2028-03-01T00:00:00Z", false],
  ])("until %s, at %s, is %s", (until, iso, away) => {
    expect(isOnHolidayAt(true, until, at(iso))).toBe(away);
  });

  it("is never on while holiday mode is off, even with a date in the future", () => {
    expect(isOnHolidayAt(false, "2099-12-31", at("2026-07-15T10:00:00Z"))).toBe(false);
  });

  it("stops telling callers about a holiday the moment it ends", () => {
    const input = { openingHours: {}, holidayMode: true, holidayUntil: "2026-07-15" };
    expect(perCallVariables(input, at("2026-07-15T22:59:59Z"))).toMatchObject({
      holiday_mode: "yes",
      holiday_until: "until 15 July 2026",
    });
    expect(perCallVariables(input, at("2026-07-15T23:00:00Z"))).toMatchObject({
      holiday_mode: "no",
      holiday_until: "not away",
    });
  });
});

describe("startOfUkDay", () => {
  it.each([
    ["2026-03-29T12:00:00Z", "2026-03-29T00:00:00.000Z"], // spring Sunday began in GMT
    ["2026-03-30T00:30:00Z", "2026-03-29T23:00:00.000Z"], // the Monday after began in BST
    ["2026-10-25T12:00:00Z", "2026-10-24T23:00:00.000Z"], // autumn Sunday began in BST
    ["2026-10-26T00:30:00Z", "2026-10-26T00:00:00.000Z"], // the Monday after began in GMT
    ["2026-07-15T22:59:59Z", "2026-07-14T23:00:00.000Z"],
    ["2026-07-15T23:00:00Z", "2026-07-15T23:00:00.000Z"], // exactly UK midnight
    ["2026-12-31T23:59:59Z", "2026-12-31T00:00:00.000Z"],
  ])("finds UK midnight before %s at %s", (iso, want) => {
    expect(startOfUkDay(at(iso)).toISOString()).toBe(want);
  });
});

describe("holidayUntilWords", () => {
  it.each([
    ["2028-02-29", "until 29 February 2028"],
    ["2026-12-31", "until 31 December 2026"],
    ["2027-01-01", "until 1 January 2027"],
    ["2026-03-29", "until 29 March 2026"],
    ["2026-10-25", "until 25 October 2026"],
  ])("says %s as %j, whatever the machine's own time zone", (date, words) => {
    expect(holidayUntilWords(date)).toBe(words);
  });
});
