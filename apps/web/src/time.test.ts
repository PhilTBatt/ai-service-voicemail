import { describe, expect, it } from "vitest";
import {
  addDays,
  dayLabel,
  formatDate,
  formatUkDateTime,
  formatUkTime,
  startOfUkDay,
  ukDate,
  UK_TIME_ZONE,
} from "./time.ts";

describe("formatUkTime", () => {
  it("shows the UK clock, an hour on in summer", () => {
    expect(formatUkTime("2026-11-07T09:05:00Z")).toBe("09:05");
    expect(formatUkTime("2026-07-01T23:30:00Z")).toBe("00:30");
  });

  it("shows midnight as 00:00, never 24:00, in both seasons", () => {
    expect(formatUkTime("2026-11-07T00:00:00Z")).toBe("00:00");
    expect(formatUkTime("2026-06-30T23:00:00Z")).toBe("00:00");
  });

  it("shows the hour the clocks go back twice, and skips the hour they go forward", () => {
    // 25 October 2026: 01:30 happens once in BST (00:30 UTC) and again in GMT (01:30 UTC).
    expect(formatUkTime("2026-10-25T00:30:00Z")).toBe("01:30");
    expect(formatUkTime("2026-10-25T01:30:00Z")).toBe("01:30");
    // 29 March 2026: one minute after 00:59 GMT is 02:00 BST.
    expect(formatUkTime("2026-03-29T00:59:00Z")).toBe("00:59");
    expect(formatUkTime("2026-03-29T01:00:00Z")).toBe("02:00");
  });
});

describe("dayLabel", () => {
  // 10:00 on Wednesday 11 November 2026, UK time (GMT).
  const now = new Date("2026-11-11T10:00:00Z");

  it("says today and yesterday by the UK calendar, not UTC's", () => {
    expect(dayLabel("2026-11-11T00:10:00Z", now)).toBe("Today");
    expect(dayLabel("2026-11-10T23:59:00Z", now)).toBe("Yesterday");
    // 23:30 UTC on 30 June is 00:30 on 1 July in the UK (BST).
    const summer = new Date("2026-07-01T12:00:00Z");
    expect(dayLabel("2026-06-30T23:30:00Z", summer)).toBe("Today");
  });

  it("names older days, with the year only when it isn't this one", () => {
    expect(dayLabel("2026-11-09T12:00:00Z", now)).toBe("Mon 9 Nov");
    expect(dayLabel("2025-12-31T12:00:00Z", now)).toBe("Wed 31 Dec 2025");
  });

  it("counts yesterday across the clocks going back", () => {
    // Sunday 25 October 2026 has 25 hours; 00:30 BST that day is 23:30 UTC on the 24th.
    const monday = new Date("2026-10-26T09:00:00Z");
    expect(dayLabel("2026-10-24T23:30:00Z", monday)).toBe("Yesterday");
  });
});

describe("formatUkDateTime", () => {
  it("shows winter times as they are and summer times an hour on", () => {
    expect(formatUkDateTime("2026-11-07T09:00:00Z")).toBe("Sat 7 Nov 2026, 09:00");
    expect(formatUkDateTime("2026-07-01T09:00:00Z")).toBe("Wed 1 Jul 2026, 10:00");
  });

  it("puts a late-evening summer call on the next UK day", () => {
    expect(formatUkDateTime("2026-06-30T23:30:00Z")).toBe("Wed 1 Jul 2026, 00:30");
  });

  it("handles both clock-change weekends of 2026", () => {
    // Clocks go forward at 01:00 UTC on Sunday 29 March: 00:59 GMT, then 02:00 BST.
    expect(formatUkDateTime("2026-03-29T00:59:00Z")).toBe("Sun 29 Mar 2026, 00:59");
    expect(formatUkDateTime("2026-03-29T01:00:00Z")).toBe("Sun 29 Mar 2026, 02:00");
    // Clocks go back at 01:00 UTC on Sunday 25 October: 01:59 BST, then 01:00 GMT.
    expect(formatUkDateTime("2026-10-25T00:59:00Z")).toBe("Sun 25 Oct 2026, 01:59");
    expect(formatUkDateTime("2026-10-25T01:00:00Z")).toBe("Sun 25 Oct 2026, 01:00");
  });
});

describe("startOfUkDay", () => {
  it("is midnight UTC in winter and 23:00 UTC the day before in summer", () => {
    expect(startOfUkDay("2026-11-07").toISOString()).toBe("2026-11-07T00:00:00.000Z");
    expect(startOfUkDay("2026-07-01").toISOString()).toBe("2026-06-30T23:00:00.000Z");
  });

  it("gets the clock-change days and the days after them right", () => {
    expect(startOfUkDay("2026-03-29").toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(startOfUkDay("2026-03-30").toISOString()).toBe("2026-03-29T23:00:00.000Z");
    expect(startOfUkDay("2026-10-25").toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(startOfUkDay("2026-10-26").toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("agrees with Temporal for every day of 2026 and 2027", () => {
    for (let date = "2026-01-01"; date < "2028-01-01"; date = addDays(date, 1)) {
      const expected = Temporal.PlainDate.from(date)
        .toZonedDateTime({ timeZone: UK_TIME_ZONE })
        .toInstant().epochMilliseconds;
      expect(startOfUkDay(date).getTime(), date).toBe(expected);
      expect(ukDate(startOfUkDay(date)), date).toBe(date);
    }
  });

  it("refuses something that isn't a date", () => {
    expect(() => startOfUkDay("7/11/2026")).toThrow("Expected a date");
  });
});

describe("formatDate", () => {
  it("writes a date the way people do", () => {
    expect(formatDate("2026-10-14")).toBe("14 Oct 2026");
    expect(formatDate("2027-01-01")).toBe("1 Jan 2027");
  });
});

describe("addDays", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
