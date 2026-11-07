// SMS commands (BUILD_PLAN Step 6): the tradesperson texts the notification number from
// their registered mobile. Parsing here is pure; db/tenant-commands.ts applies the result.
import { UK_TIME_ZONE } from "./availability.ts";

export type SmsCommand =
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "holiday"; until: string } // YYYY-MM-DD
  | { kind: "holiday-invalid" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "unknown" };

/** The local date in the UK right now, which is what "12/12" is relative to. */
export function ukToday(now: Date): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(UK_TIME_ZONE)
    .toPlainDate();
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "dec", "sept" or "december" -> 12; anything that isn't a month name -> null. */
function monthNumber(name: string): number | null {
  const index = MONTHS.findIndex(
    (month) =>
      name === month || name === month.slice(0, 3) || (name === "sept" && month === "september"),
  );
  return index === -1 ? null : index + 1;
}

/**
 * Reads the date after HOLIDAY. Accepts 2026-12-12, 12/12/2026, 12/12/26, 12/12 and
 * "12 Dec" or "12 December". Without a year it means the next time that date comes round.
 * Past dates are invalid: a holiday that's already over isn't one.
 */
export function parseHolidayDate(text: string, today: Temporal.PlainDate): string | null {
  const t = text.trim().toLowerCase();
  let candidate: { year: number | undefined; month: number; day: number } | null = null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const numeric = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t);
  const worded = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(t);
  if (iso) {
    candidate = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  } else if (numeric) {
    const [, day, month, year] = numeric;
    candidate = {
      year: year === undefined ? undefined : Number(year.length === 2 ? `20${year}` : year),
      month: Number(month),
      day: Number(day),
    };
  } else if (worded) {
    const [, day, monthName, year] = worded;
    const month = monthNumber(monthName!);
    if (month === null) return null;
    candidate = { year: year === undefined ? undefined : Number(year), month, day: Number(day) };
  }
  if (!candidate) return null;

  const build = (year: number) => {
    try {
      return Temporal.PlainDate.from(
        { year, month: candidate.month, day: candidate.day },
        { overflow: "reject" },
      );
    } catch {
      return null;
    }
  };

  let date: Temporal.PlainDate | null = null;
  if (candidate.year !== undefined) {
    date = build(candidate.year);
  } else {
    // The next time this day and month come round, which for 29 Feb can be years away.
    for (let year = today.year; year <= today.year + 4 && date === null; year++) {
      const attempt = build(year);
      if (attempt && Temporal.PlainDate.compare(attempt, today) >= 0) date = attempt;
    }
  }
  if (!date || Temporal.PlainDate.compare(date, today) < 0) return null;
  return date.toString();
}

export function parseSmsCommand(body: string, today: Temporal.PlainDate): SmsCommand {
  const text = body
    .trim()
    .replace(/[.!]+$/, "")
    .trim();
  const [word = "", ...rest] = text.split(/\s+/);
  switch (word.toUpperCase()) {
    case "OFF":
    case "PAUSE":
    case "STOP":
      return { kind: "off" };
    case "ON":
    case "RESUME":
    case "START":
      return { kind: "on" };
    case "HOLIDAY":
    case "HOLS":
    case "AWAY": {
      const until = parseHolidayDate(rest.join(" "), today);
      return until ? { kind: "holiday", until } : { kind: "holiday-invalid" };
    }
    case "STATUS":
      return { kind: "status" };
    case "HELP":
    case "?":
      return { kind: "help" };
    default:
      return { kind: "unknown" };
  }
}

/** 2026-12-12 -> "12 Dec 2026", for replies. */
export function formatUkDate(isoDate: string): string {
  return Temporal.PlainDate.from(isoDate).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export const HELP_REPLY =
  "AnswerMate commands: OFF (pause, callers leave a voicemail), ON (resume), HOLIDAY 12/12 (away until that date), STATUS, HELP.";

export const UNKNOWN_REPLY = "Sorry, I didn't understand that. Reply HELP for the commands.";

export const HOLIDAY_INVALID_REPLY =
  "Sorry, I didn't understand that date. Try HOLIDAY 12/12 or HOLIDAY 2026-12-12.";
