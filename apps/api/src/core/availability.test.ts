import { describe, expect, it } from "vitest";
import { isOnHolidayAt, isOpenAt, perCallVariables, startOfUkDay } from "./availability.ts";
import type { OpeningHours } from "./profile.ts";

// Mon–Fri 08:00–18:00, Sat 09:00–13:00, Sun 09:00–12:00 (Sunday hours only for the clock-change tests).
const HOURS: OpeningHours = {
  mon: { open: "08:00", close: "18:00" },
  tue: { open: "08:00", close: "18:00" },
  wed: { open: "08:00", close: "18:00" },
  thu: { open: "08:00", close: "18:00" },
  fri: { open: "08:00", close: "18:00" },
  sat: { open: "09:00", close: "13:00" },
  sun: { open: "09:00", close: "12:00" },
};
const at = (iso: string) => new Date(iso);

describe("isOpenAt", () => {
  it("uses UK local time, which is UTC+1 in summer and UTC in winter", () => {
    // Wednesday 15 July 2026: 07:30 UTC is 08:30 BST (open); 06:30 UTC is 07:30 BST (closed).
    expect(isOpenAt(HOURS, at("2026-07-15T07:30:00Z"))).toBe(true);
    expect(isOpenAt(HOURS, at("2026-07-15T06:30:00Z"))).toBe(false);
    // Wednesday 14 January 2026: 07:30 UTC is 07:30 GMT (closed); 08:30 UTC is open.
    expect(isOpenAt(HOURS, at("2026-01-14T07:30:00Z"))).toBe(false);
    expect(isOpenAt(HOURS, at("2026-01-14T08:30:00Z"))).toBe(true);
  });

  it("is right on the spring clock change (29 March 2026, clocks go forward at 01:00 UTC)", () => {
    // Sunday hours 09:00–12:00 BST are 08:00–11:00 UTC that day.
    expect(isOpenAt(HOURS, at("2026-03-29T07:30:00Z"))).toBe(false); // 08:30 BST
    expect(isOpenAt(HOURS, at("2026-03-29T08:30:00Z"))).toBe(true); // 09:30 BST
    expect(isOpenAt(HOURS, at("2026-03-29T11:30:00Z"))).toBe(false); // 12:30 BST: closed, though 11:30 "winter time" would be open
  });

  it("is right on the autumn clock change (25 October 2026, clocks go back at 01:00 UTC)", () => {
    // Sunday hours 09:00–12:00 GMT are 09:00–12:00 UTC that day.
    expect(isOpenAt(HOURS, at("2026-10-25T08:30:00Z"))).toBe(false); // 08:30 GMT: closed, though 09:30 "summer time" would be open
    expect(isOpenAt(HOURS, at("2026-10-25T09:30:00Z"))).toBe(true);
    expect(isOpenAt(HOURS, at("2026-10-25T11:59:00Z"))).toBe(true);
    expect(isOpenAt(HOURS, at("2026-10-25T12:00:00Z"))).toBe(false); // close is exclusive
  });

  it("picks the weekday by UK local date, not UTC date", () => {
    // Sunday 19 July 2026 23:30 UTC is Monday 00:30 BST: Monday's hours apply (closed at that hour).
    expect(isOpenAt({ sun: { open: "00:00", close: "23:59" } }, at("2026-07-19T23:30:00Z"))).toBe(
      false,
    );
    expect(isOpenAt({ mon: { open: "00:00", close: "01:00" } }, at("2026-07-19T23:30:00Z"))).toBe(
      true,
    );
  });

  it("treats a missing or null day as closed", () => {
    expect(isOpenAt({}, at("2026-07-15T10:00:00Z"))).toBe(false);
    expect(isOpenAt({ wed: null }, at("2026-07-15T10:00:00Z"))).toBe(false);
  });
});

describe("isOnHolidayAt", () => {
  it("is off when holiday mode is off, whatever the date", () => {
    expect(isOnHolidayAt(false, "2099-01-01", at("2026-07-15T10:00:00Z"))).toBe(false);
  });

  it("is on until further notice when no end date is set", () => {
    expect(isOnHolidayAt(true, null, at("2026-07-15T10:00:00Z"))).toBe(true);
  });

  it("includes the whole of the end date in UK time, then switches off", () => {
    // 1 July 2026 23:30 UTC is already 2 July 00:30 BST: the holiday is over.
    expect(isOnHolidayAt(true, "2026-07-01", at("2026-07-01T22:30:00Z"))).toBe(true); // 23:30 BST on the 1st
    expect(isOnHolidayAt(true, "2026-07-01", at("2026-07-01T23:30:00Z"))).toBe(false);
    // In winter UTC and UK time agree.
    expect(isOnHolidayAt(true, "2026-11-10", at("2026-11-10T23:59:00Z"))).toBe(true);
    expect(isOnHolidayAt(true, "2026-11-10", at("2026-11-11T00:00:00Z"))).toBe(false);
  });
});

describe("perCallVariables", () => {
  it('gives "yes"/"no" strings for the agent', () => {
    expect(
      perCallVariables(
        { openingHours: HOURS, holidayMode: true, holidayUntil: null },
        at("2026-07-15T10:00:00Z"),
      ),
    ).toEqual({ open_now: "yes", holiday_mode: "yes", holiday_until: "until further notice" });
    expect(
      perCallVariables(
        { openingHours: HOURS, holidayMode: false, holidayUntil: null },
        at("2026-07-15T20:00:00Z"),
      ),
    ).toEqual({ open_now: "no", holiday_mode: "no", holiday_until: "not away" });
  });

  // A HOLIDAY text changes the date without a new profile version, so the agent's instructions
  // can't carry it: each call does, and callers hear the latest one.
  it("sends the holiday's last day with each call, and nothing once it's over", () => {
    const away = { openingHours: HOURS, holidayMode: true, holidayUntil: "2026-12-20" };
    expect(perCallVariables(away, at("2026-12-20T12:00:00Z")).holiday_until).toBe(
      "until 20 December 2026",
    );
    expect(perCallVariables(away, at("2026-12-21T12:00:00Z"))).toMatchObject({
      holiday_mode: "no",
      holiday_until: "not away",
    });
  });
});

describe("startOfUkDay", () => {
  const start = (iso: string) => startOfUkDay(new Date(iso)).toISOString();

  it("finds UK midnight in winter and summer, and just after midnight in BST", () => {
    expect(start("2026-01-15T12:00:00Z")).toBe("2026-01-15T00:00:00.000Z"); // GMT
    expect(start("2026-07-15T12:00:00Z")).toBe("2026-07-14T23:00:00.000Z"); // BST
    expect(start("2026-07-14T23:30:00Z")).toBe("2026-07-14T23:00:00.000Z"); // 00:30 BST on the 15th
  });

  it("finds it on the days the clocks change", () => {
    // 29 March: the clocks go forward at 01:00 GMT, so the day began at 00:00 GMT.
    expect(start("2026-03-29T12:00:00Z")).toBe("2026-03-29T00:00:00.000Z");
    // 25 October: they go back at 01:00 GMT (02:00 BST), so the day began at 00:00 BST.
    expect(start("2026-10-25T00:30:00Z")).toBe("2026-10-24T23:00:00.000Z");
    expect(start("2026-10-25T12:00:00Z")).toBe("2026-10-24T23:00:00.000Z");
  });
});
