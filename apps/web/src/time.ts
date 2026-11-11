// UK time for the dashboard. Everything is stored in UTC and shown in Europe/London
// (CLAUDE.md). The API uses Temporal; not every browser has it yet, so this uses Intl, which
// every browser has and which carries the same time zone database. The tests check these
// functions against Temporal for every day of two years, clock-change days included.

export const UK_TIME_ZONE = "Europe/London";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const ukClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

interface UkParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The UK wall-clock reading at an instant. Numbers only: names are ours, not the browser's. */
export function ukParts(at: Date): UkParts {
  const parts = Object.fromEntries(
    ukClock.formatToParts(at).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Sat 7 Nov 2026, 09:00" in UK time. */
export function formatUkDateTime(iso: string): string {
  const p = ukParts(new Date(iso));
  const weekday = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]!;
  return `${weekday} ${p.day} ${MONTHS[p.month - 1]!} ${p.year}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/** The UK calendar date at an instant, as YYYY-MM-DD (what a date input holds). */
export function ukDate(at: Date): string {
  const p = ukParts(at);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function parseDate(date: string): [year: number, month: number, day: number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Expected a date like 2026-11-07, got "${date}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** A YYYY-MM-DD date as people write it: "14 Oct 2026". A date has no time, so no zone. */
export function formatDate(date: string): string {
  const [year, month, day] = parseDate(date);
  return `${day} ${MONTHS[month - 1]!} ${year}`;
}

/** The date `days` after (or before) a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** How far UK time is ahead of UTC at an instant, in milliseconds (0 in winter, 1 hour in summer). */
function ukOffsetMs(at: number): number {
  const p = ukParts(new Date(at));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / 60_000) * 60_000;
}

/**
 * The instant UK midnight starts a date. UK clocks change at 01:00 UTC, never at midnight,
 * so every UK day has exactly one midnight; the second pass covers the offset changing
 * between the first guess and the answer.
 */
export function startOfUkDay(date: string): Date {
  const [year, month, day] = parseDate(date);
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  const first = midnightAsUtc - ukOffsetMs(midnightAsUtc);
  return new Date(midnightAsUtc - ukOffsetMs(first));
}
