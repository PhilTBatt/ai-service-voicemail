// The call list's filters at their edges: UK days that are 23 or 25 hours long, days that
// follow each other with no gap or overlap, and addresses that someone typed or mangled.
import { URGENCIES } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  callsQuery,
  filtersFromSearch,
  NO_FILTERS,
  searchFromFilters,
  type CallFilters,
} from "./calls-query.ts";
import { addDays } from "./time.ts";

const HOUR = 3_600_000;

/** The instants one UK day's filter asks the API for. */
function range(from: string, to: string = from) {
  const query = new URLSearchParams(callsQuery({ ...NO_FILTERS, from, to }));
  return { from: Date.parse(query.get("from")!), to: Date.parse(query.get("to")!) };
}

describe("a day's range", () => {
  it("is 24 hours every day of 2026 and 2027 but the four clock-change Sundays", () => {
    const odd: Record<string, number> = {};
    for (let date = "2026-01-01"; date < "2028-01-01"; date = addDays(date, 1)) {
      const { from, to } = range(date);
      const hours = (to - from) / HOUR;
      if (hours !== 24) odd[date] = hours;
    }
    expect(odd).toEqual({
      "2026-03-29": 23,
      "2026-10-25": 25,
      "2027-03-28": 23,
      "2027-10-31": 25,
    });
  });

  it("starts where the day before ends, so no call falls between two days or into both", () => {
    for (let date = "2026-01-01"; date < "2027-01-01"; date = addDays(date, 1)) {
      expect(range(addDays(date, 1)).from, date).toBe(range(date).to);
    }
  });

  it("covers the clock-change weekends of 2027", () => {
    expect(range("2027-03-27", "2027-03-28")).toEqual({
      from: Date.parse("2027-03-27T00:00:00Z"),
      to: Date.parse("2027-03-28T23:00:00Z"),
    });
    expect(range("2027-10-30", "2027-10-31")).toEqual({
      from: Date.parse("2027-10-29T23:00:00Z"),
      to: Date.parse("2027-11-01T00:00:00Z"),
    });
  });

  it("includes a leap day", () => {
    expect(range("2028-02-29")).toEqual({
      from: Date.parse("2028-02-29T00:00:00Z"),
      to: Date.parse("2028-03-01T00:00:00Z"),
    });
  });

  it("sends only the end that's set", () => {
    expect(callsQuery({ ...NO_FILTERS, from: "2026-11-01" })).toBe(
      "from=2026-11-01T00%3A00%3A00.000Z",
    );
    expect(callsQuery({ ...NO_FILTERS, to: "2026-11-01" })).toBe("to=2026-11-02T00%3A00%3A00.000Z");
  });

  it("sends a backwards range as it is: the API answers it with no calls, not an error", () => {
    const { from, to } = range("2026-11-10", "2026-11-01");
    expect(from).toBeGreaterThan(to);
  });
});

describe("callsQuery", () => {
  it("only ever sends the API's own names", () => {
    const query = new URLSearchParams(
      callsQuery(
        { urgency: "spam", from: "2026-01-01", to: "2026-01-02", needsReply: true },
        "2026-01-02T10:00:00.000Z",
      ),
    );
    expect([...query.keys()].sort()).toEqual(["before", "from", "needsReply", "to", "urgency"]);
  });

  it("leaves the cursor off when there isn't one", () => {
    expect(callsQuery(NO_FILTERS, null)).toBe("");
    expect(callsQuery(NO_FILTERS, "")).toBe("");
    expect(callsQuery(NO_FILTERS, undefined)).toBe("");
  });

  it("encodes a cursor with an offset, so its + isn't read as a space", () => {
    const query = new URLSearchParams(callsQuery(NO_FILTERS, "2026-07-01T10:00:00+01:00"));
    expect(query.get("before")).toBe("2026-07-01T10:00:00+01:00");
  });
});

describe("filters in the page's address", () => {
  it("keeps real dates, leap days included, and drops ones that don't exist", () => {
    const from = (value: string) => filtersFromSearch(new URLSearchParams({ from: value })).from;
    expect(from("2028-02-29")).toBe("2028-02-29");
    expect(from("2026-12-31")).toBe("2026-12-31");
    for (const impossible of [
      "2027-02-29",
      "2026-02-30",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-11-00",
      "2026-11-01x",
      "2026-11-1",
      "+02026-11-01",
    ]) {
      expect(from(impossible), impossible).toBe("");
    }
  });

  it("keeps the year Chrome's date box reports while it's being typed, digit by digit", () => {
    // Typing 2026 into the year shows 0002, 0020, 0202, then 2026. Dropping the early ones
    // would blank the box under the person's fingers.
    for (const typing of ["0002-11-01", "0020-11-01", "0202-11-01", "2026-11-01"]) {
      expect(filtersFromSearch(new URLSearchParams({ to: typing })).to).toBe(typing);
    }
  });

  it("knows every urgency, exactly as the API spells it", () => {
    for (const urgency of URGENCIES) {
      expect(filtersFromSearch(new URLSearchParams({ urgency })).urgency).toBe(urgency);
    }
    expect(filtersFromSearch(new URLSearchParams({ urgency: "URGENT" })).urgency).toBe("");
    expect(filtersFromSearch(new URLSearchParams({ urgency: " urgent" })).urgency).toBe("");
  });

  it("only takes needsReply=1, the form the page writes", () => {
    const needsReply = (value: string) =>
      filtersFromSearch(new URLSearchParams({ needsReply: value })).needsReply;
    expect(needsReply("1")).toBe(true);
    for (const other of ["0", "true", "yes", ""]) expect(needsReply(other), other).toBe(false);
  });

  it("uses the first of a repeated filter", () => {
    expect(filtersFromSearch(new URLSearchParams("urgency=urgent&urgency=emergency")).urgency).toBe(
      "urgent",
    );
  });

  it("reads back exactly what it wrote, for every combination", () => {
    for (const urgency of ["", ...URGENCIES]) {
      for (const needsReply of [false, true]) {
        for (const [from, to] of [
          ["", ""],
          ["2026-10-24", ""],
          ["", "2026-10-25"],
          ["2026-03-29", "2026-10-25"],
        ] as const) {
          const filters: CallFilters = { urgency, from, to, needsReply };
          expect(filtersFromSearch(searchFromFilters(filters))).toEqual(filters);
        }
      }
    }
  });

  it("survives a trip through the address bar as text", () => {
    const filters = {
      urgency: "emergency",
      from: "2026-11-01",
      to: "2026-11-07",
      needsReply: true,
    };
    const asText = `?${searchFromFilters(filters).toString()}`;
    expect(filtersFromSearch(new URLSearchParams(asText))).toEqual(filters);
  });
});
