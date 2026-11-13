// Whether a tenant is open or away right now, in UK time. Fed to the agent as per-call
// variables (decision 009). Uses the built-in Temporal API, which handles the clock-change
// weekends correctly; the tests cover both of them.
import { WEEKDAYS, type OpeningHours } from "./profile.ts";

export const UK_TIME_ZONE = "Europe/London";

function localTime(at: Date, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(timeZone);
}

function minutesOfDay(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
}

/**
 * True when the local time falls inside an opening slot (close is exclusive): today's, or
 * yesterday's when that one runs overnight (closes earlier than it opens, so the next morning).
 * Wall-clock times, so a slot means the same hours either side of a clock change.
 */
export function isOpenAt(hours: OpeningHours, at: Date, timeZone = UK_TIME_ZONE): boolean {
  const local = localTime(at, timeZone);
  const now = local.hour * 60 + local.minute;
  // Temporal: 1 is Monday, 7 is Sunday; yesterday wraps Monday back to Sunday.
  const today = hours[WEEKDAYS[local.dayOfWeek - 1]!];
  const yesterday = hours[WEEKDAYS[(local.dayOfWeek + 5) % 7]!];
  if (today) {
    const open = minutesOfDay(today.open);
    const close = minutesOfDay(today.close);
    // An overnight slot is open from its opening time to midnight today, and on into tomorrow.
    if (close > open ? now >= open && now < close : now >= open) return true;
  }
  if (yesterday) {
    const open = minutesOfDay(yesterday.open);
    const close = minutesOfDay(yesterday.close);
    if (close < open && now < close) return true;
  }
  return false;
}

/** True while holiday mode is on: until further notice, or through the end of the given local date. */
export function isOnHolidayAt(
  holidayMode: boolean,
  holidayUntil: string | null,
  at: Date,
  timeZone = UK_TIME_ZONE,
): boolean {
  if (!holidayMode) return false;
  if (holidayUntil === null) return true;
  const today = localTime(at, timeZone).toPlainDate();
  return Temporal.PlainDate.compare(today, Temporal.PlainDate.from(holidayUntil)) <= 0;
}

/** Midnight at the start of the UK day that `at` falls in, as an instant. */
export function startOfUkDay(at: Date, timeZone = UK_TIME_ZONE): Date {
  return new Date(localTime(at, timeZone).startOfDay().epochMilliseconds);
}

export interface AvailabilityInput {
  openingHours: OpeningHours;
  holidayMode: boolean;
  holidayUntil: string | null;
}

/**
 * The values for the agent's {{open_now}}, {{holiday_mode}} and {{holiday_until}} variables.
 * The holiday's end goes with each call rather than into the agent's instructions, because a
 * HOLIDAY text changes it without making a new profile version, and the instructions only
 * change when a new version is synced: the date callers heard used to be the old one.
 */
export function perCallVariables(input: AvailabilityInput, at: Date): Record<string, string> {
  const away = isOnHolidayAt(input.holidayMode, input.holidayUntil, at);
  return {
    open_now: isOpenAt(input.openingHours, at) ? "yes" : "no",
    holiday_mode: away ? "yes" : "no",
    holiday_until: away ? holidayUntilWords(input.holidayUntil) : "not away",
  };
}

/** "until 20 December 2026", or "until further notice" with no end date. */
export function holidayUntilWords(holidayUntil: string | null): string {
  if (holidayUntil === null) return "until further notice";
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${holidayUntil}T00:00:00Z`));
  return `until ${date}`;
}
