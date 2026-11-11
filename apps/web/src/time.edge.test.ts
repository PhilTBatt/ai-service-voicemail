// UK time at its edges: every clock change from 2026 to 2028, midnight, New Year, leap days,
// and each function checked against Temporal (Node has it; not every browser does yet, which
// is why time.ts uses Intl) for years at a time, so a gap in time.ts's own reasoning shows up.
import { describe, expect, it } from "vitest";
import {
  addDays,
  dayLabel,
  formatDate,
  formatUkDateTime,
  formatUkTime,
  startOfUkDay,
  ukDate,
  ukParts,
  UK_TIME_ZONE,
} from "./time.ts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // Temporal: 1 is Monday
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** What Temporal says the UK clock reads at an instant. */
function temporalUk(ms: number) {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(UK_TIME_ZONE);
}

/** The clock changes: [last instant before, first instant after], both in UTC. */
const CLOCK_CHANGES = [
  { date: "2026-03-29", forward: true },
  { date: "2026-10-25", forward: false },
  { date: "2027-03-28", forward: true },
  { date: "2027-10-31", forward: false },
  { date: "2028-03-26", forward: true },
  { date: "2028-10-29", forward: false },
];

describe("formatUkDateTime and formatUkTime against Temporal", () => {
  // 26,304 hours, each formatted three ways and checked against Temporal: about 2.5 s alone, but
  // over the default 5 s under the full suite's load (2026-11-11). Nothing it checks is cut.
  it("agree for every hour of 2026 to 2028", { timeout: 30_000 }, () => {
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2029, 0, 1);
    for (let ms = start; ms < end; ms += HOUR) {
      const uk = temporalUk(ms);
      const iso = new Date(ms).toISOString();
      const expected = `${WEEKDAYS[uk.dayOfWeek - 1]!} ${uk.day} ${MONTHS[uk.month - 1]!} ${uk.year}, ${pad(uk.hour)}:${pad(uk.minute)}`;
      expect(formatUkDateTime(iso), iso).toBe(expected);
      expect(formatUkTime(iso), iso).toBe(`${pad(uk.hour)}:${pad(uk.minute)}`);
      expect(ukDate(new Date(ms)), iso).toBe(uk.toPlainDate().toString());
    }
  });

  it("agree minute by minute through every clock change of 2026 to 2028", () => {
    for (const { date } of CLOCK_CHANGES) {
      // 23:00 UTC the evening before to 03:00 UTC: both sides of 01:00 UTC.
      const from = Date.parse(`${date}T00:00:00Z`) - HOUR;
      for (let ms = from; ms < from + 4 * HOUR; ms += 60_000) {
        const uk = temporalUk(ms);
        expect(formatUkTime(new Date(ms).toISOString()), new Date(ms).toISOString()).toBe(
          `${pad(uk.hour)}:${pad(uk.minute)}`,
        );
      }
    }
  });
});

describe("the clock changes", () => {
  it.each(CLOCK_CHANGES.filter((change) => change.forward))(
    "never shows a time between 01:00 and 01:59 on $date, when the clocks go forward",
    ({ date }) => {
      const midnight = Date.parse(`${date}T00:00:00Z`);
      for (let ms = midnight; ms < midnight + 3 * HOUR; ms += 60_000) {
        expect(formatUkTime(new Date(ms).toISOString())).not.toMatch(/^01:/);
      }
      expect(formatUkTime(new Date(midnight + HOUR - 60_000).toISOString())).toBe("00:59");
      expect(formatUkTime(new Date(midnight + HOUR).toISOString())).toBe("02:00");
    },
  );

  it.each(CLOCK_CHANGES.filter((change) => !change.forward))(
    "shows 01:00 to 01:59 twice on $date, when the clocks go back, both on the same day",
    ({ date }) => {
      const firstTime = new Date(`${date}T00:15:00Z`); // 01:15 BST
      const secondTime = new Date(`${date}T01:15:00Z`); // 01:15 GMT
      expect(formatUkTime(firstTime.toISOString())).toBe("01:15");
      expect(formatUkTime(secondTime.toISOString())).toBe("01:15");
      expect(ukDate(firstTime)).toBe(date);
      expect(ukDate(secondTime)).toBe(date);
    },
  );

  it("makes the spring day 23 hours long and the autumn day 25", () => {
    for (const { date, forward } of CLOCK_CHANGES) {
      const length = startOfUkDay(addDays(date, 1)).getTime() - startOfUkDay(date).getTime();
      expect(length / HOUR, date).toBe(forward ? 23 : 25);
    }
  });
});

describe("dayLabel at the edges", () => {
  it("turns over at UK midnight in summer, an hour before UTC's", () => {
    // 00:05 BST on Thursday 2 July 2026.
    const now = new Date("2026-07-01T23:05:00Z");
    expect(dayLabel("2026-07-01T23:00:00Z", now)).toBe("Today"); // 00:00 BST
    expect(dayLabel("2026-07-01T22:59:00Z", now)).toBe("Yesterday"); // 23:59 BST on the 1st
  });

  it("counts New Year's Eve as yesterday on New Year's Day, and adds the year after that", () => {
    const newYearsDay = new Date("2027-01-01T09:00:00Z");
    expect(dayLabel("2026-12-31T23:59:00Z", newYearsDay)).toBe("Yesterday");
    expect(dayLabel("2026-12-30T12:00:00Z", newYearsDay)).toBe("Wed 30 Dec 2026");
    expect(dayLabel("2027-01-01T00:00:00Z", newYearsDay)).toBe("Today");
  });

  it("counts yesterday across the clocks going forward", () => {
    // 09:00 BST on Monday 30 March 2026; 00:30 GMT on the Sunday was yesterday.
    const monday = new Date("2026-03-30T08:00:00Z");
    expect(dayLabel("2026-03-29T00:30:00Z", monday)).toBe("Yesterday");
    expect(dayLabel("2026-03-28T23:30:00Z", monday)).toBe("Sat 28 Mar");
  });

  it("names a leap day", () => {
    expect(dayLabel("2028-02-29T12:00:00Z", new Date("2028-03-01T12:00:00Z"))).toBe("Yesterday");
    expect(dayLabel("2028-02-29T12:00:00Z", new Date("2028-03-02T12:00:00Z"))).toBe("Tue 29 Feb");
  });

  it("never calls a call from the future 'Today' or 'Yesterday' unless it is", () => {
    // A clock running slow somewhere: a call stamped tomorrow is named, not hidden.
    const now = new Date("2026-11-11T10:00:00Z");
    expect(dayLabel("2026-11-12T10:00:00Z", now)).toBe("Thu 12 Nov");
  });

  it("is Today from UK midnight and Yesterday a minute before, every day of 2026 to 2027", () => {
    const named = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}( \d{4})?$/;
    for (let date = "2026-01-01"; date < "2028-01-01"; date = addDays(date, 1)) {
      const midnight = startOfUkDay(date).getTime();
      const noon = new Date(midnight + 12 * HOUR);
      const at = (ms: number) => new Date(ms).toISOString();
      expect(dayLabel(at(midnight), noon), date).toBe("Today");
      expect(dayLabel(at(midnight - 60_000), noon), date).toBe("Yesterday");
      const yesterdayStart = startOfUkDay(addDays(date, -1)).getTime();
      expect(dayLabel(at(yesterdayStart - 60_000), noon), date).toMatch(named);
    }
  });
});

describe("startOfUkDay against Temporal", () => {
  it("agrees for every day from 2000 to 2040, leap days and clock changes included", () => {
    for (let date = "2000-01-01"; date < "2041-01-01"; date = addDays(date, 1)) {
      const expected = Temporal.PlainDate.from(date)
        .toZonedDateTime({ timeZone: UK_TIME_ZONE })
        .toInstant().epochMilliseconds;
      expect(startOfUkDay(date).getTime(), date).toBe(expected);
    }
  });

  it("refuses anything that isn't YYYY-MM-DD", () => {
    for (const bad of ["", "2026-1-1", "2026-11-07T00:00:00Z", " 2026-11-07", "07/11/2026"]) {
      expect(() => startOfUkDay(bad), bad).toThrow("Expected a date");
    }
  });
});

describe("addDays", () => {
  it("follows the leap-year rules, 2000 and 2100 included", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2000-02-28", 1)).toBe("2000-02-29"); // divisible by 400: a leap year
    expect(addDays("2100-02-28", 1)).toBe("2100-03-01"); // divisible by 100: not one
  });

  it("goes a long way in either direction, and adding nothing changes nothing", () => {
    expect(addDays("2026-11-11", 0)).toBe("2026-11-11");
    expect(addDays("2026-11-11", 365)).toBe("2027-11-11");
    expect(addDays("2028-11-11", -366)).toBe("2027-11-11");
  });

  it("comes back to where it started", () => {
    for (let date = "2026-01-01"; date < "2027-01-01"; date = addDays(date, 7)) {
      for (const days of [-400, -31, -1, 1, 29, 400]) {
        expect(addDays(addDays(date, days), -days)).toBe(date);
      }
    }
  });

  it("isn't thrown by the clock changes: a date has no time", () => {
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
  });
});

describe("formatDate", () => {
  it("writes every month's name and a leap day", () => {
    expect(MONTHS.map((_, i) => formatDate(`2026-${pad(i + 1)}-01`))).toEqual(
      MONTHS.map((month) => `1 ${month} 2026`),
    );
    expect(formatDate("2028-02-29")).toBe("29 Feb 2028");
  });

  it("refuses a date with a time on it", () => {
    expect(() => formatDate("2026-11-07T09:00:00Z")).toThrow("Expected a date");
  });
});

describe("reading the times the API sends", () => {
  it("accepts an offset and milliseconds, and cuts seconds off rather than rounding", () => {
    expect(formatUkDateTime("2026-07-01T10:00:00.999+01:00")).toBe("Wed 1 Jul 2026, 10:00");
    expect(formatUkTime("2026-11-07T09:59:59.999Z")).toBe("09:59");
  });

  it("gives plain numbers from ukParts, the hour never 24", () => {
    expect(ukParts(new Date("2026-11-07T00:00:00Z"))).toEqual({
      year: 2026,
      month: 11,
      day: 7,
      hour: 0,
      minute: 0,
    });
    expect(ukParts(new Date("2026-06-30T23:00:00Z")).hour).toBe(0);
  });
});
