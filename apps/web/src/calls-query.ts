// The call list's filters, as the person picks them (UK dates), turned into the API's query
// (UTC instants). "From 1 Nov to 7 Nov" means from UK midnight starting 1 Nov up to, but not
// including, UK midnight starting 8 Nov.
import { addDays, startOfUkDay } from "./time.ts";

export interface CallFilters {
  /** "" for every urgency. */
  urgency: string;
  /** YYYY-MM-DD in UK time, or "" for no limit. */
  from: string;
  to: string;
}

export const NO_FILTERS: CallFilters = { urgency: "", from: "", to: "" };

export function callsQuery(filters: CallFilters, before?: string | null): string {
  const query = new URLSearchParams();
  if (filters.urgency !== "") query.set("urgency", filters.urgency);
  if (filters.from !== "") query.set("from", startOfUkDay(filters.from).toISOString());
  if (filters.to !== "") query.set("to", startOfUkDay(addDays(filters.to, 1)).toISOString());
  if (before) query.set("before", before);
  return query.toString();
}
