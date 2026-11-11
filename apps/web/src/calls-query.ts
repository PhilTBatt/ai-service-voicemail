// The call list's filters, as the person picks them (UK dates), turned into the API's query
// (UTC instants). "From 1 Nov to 7 Nov" means from UK midnight starting 1 Nov up to, but not
// including, UK midnight starting 8 Nov.
import { URGENCIES } from "@callmate/shared";
import { addDays, startOfUkDay } from "./time.ts";

export interface CallFilters {
  /** "" for every urgency. */
  urgency: string;
  /** YYYY-MM-DD in UK time, or "" for no limit. */
  from: string;
  to: string;
  /** Only the calls still waiting for a reply: not marked called back, and not spam. */
  needsReply: boolean;
}

export const NO_FILTERS: CallFilters = { urgency: "", from: "", to: "", needsReply: false };

const UK_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date that exists on the calendar. The shape alone lets "2026-02-30" through: the date box
 * can't show it (it goes blank), yet the query would quietly roll it on to 2 March. Any year
 * is kept, even 0002: Chrome's date box reports the year digit by digit as it's typed, and
 * refusing one would blank the box mid-typing. setUTCFullYear, not Date.UTC, which reads
 * years 0–99 as 1900–1999.
 */
function isCalendarDate(value: string): boolean {
  if (!UK_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  return at.toISOString().slice(0, 10) === value;
}

/**
 * The filters as the page's address carries them (?urgency=urgent&needsReply=1), so they
 * survive opening a call and coming back, and a filtered list can be bookmarked. Anything that
 * isn't a filter, or isn't a valid one, is ignored rather than sent on.
 */
export function filtersFromSearch(search: URLSearchParams): CallFilters {
  const urgency = search.get("urgency") ?? "";
  const date = (value: string | null) => (value !== null && isCalendarDate(value) ? value : "");
  return {
    urgency: (URGENCIES as readonly string[]).includes(urgency) ? urgency : "",
    from: date(search.get("from")),
    to: date(search.get("to")),
    needsReply: search.get("needsReply") === "1",
  };
}

/** The other way: only the filters that are set, so an unfiltered list has a plain address. */
export function searchFromFilters(filters: CallFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.urgency !== "") search.set("urgency", filters.urgency);
  if (filters.from !== "") search.set("from", filters.from);
  if (filters.to !== "") search.set("to", filters.to);
  if (filters.needsReply) search.set("needsReply", "1");
  return search;
}

export function callsQuery(filters: CallFilters, before?: string | null): string {
  const query = new URLSearchParams();
  if (filters.urgency !== "") query.set("urgency", filters.urgency);
  if (filters.from !== "") query.set("from", startOfUkDay(filters.from).toISOString());
  if (filters.to !== "") query.set("to", startOfUkDay(addDays(filters.to, 1)).toISOString());
  if (filters.needsReply) query.set("needsReply", "true");
  if (before) query.set("before", before);
  return query.toString();
}
