import { describe, expect, it } from "vitest";
import { callsQuery, filtersFromSearch, NO_FILTERS, searchFromFilters } from "./calls-query.ts";
import {
  billingSummary,
  formatDuration,
  formatPence,
  formatPhone,
  humanise,
  toUkMobileE164,
  urgencyLabel,
} from "./format.ts";

describe("format", () => {
  it("humanises stored values", () => {
    expect(humanise("heating_engineer")).toBe("Heating engineer");
    expect(humanise("live")).toBe("Live");
  });

  it("shows whole pence as pounds and pence", () => {
    expect(formatPence(148)).toBe("£1.48");
    expect(formatPence(7)).toBe("£0.07");
    expect(formatPence(0)).toBe("£0.00");
    expect(formatPence(-250)).toBe("-£2.50");
  });

  it("shows call lengths as minutes and seconds", () => {
    expect(formatDuration(42)).toBe("0:42");
    expect(formatDuration(125)).toBe("2:05");
    expect(formatDuration(0)).toBe("0:00");
  });

  it("writes UK numbers the way people do", () => {
    expect(formatPhone("+447700900123")).toBe("07700 900123");
    expect(formatPhone("+441632960123")).toBe("01632960123");
    expect(formatPhone("+15555550123")).toBe("+15555550123");
  });

  it("turns a mobile number as people type it into the stored form", () => {
    for (const typed of [
      "07700 900123",
      "+44 7700 900123",
      "0044 (7700) 900-123",
      "447700900123",
    ]) {
      expect(toUkMobileE164(typed), typed).toBe("+447700900123");
    }
    // Not a UK mobile: left for the schema to refuse.
    expect(toUkMobileE164("0113 496 0000")).toBe("01134960000");
  });

  it("labels urgency, including calls not processed yet", () => {
    expect(urgencyLabel("emergency")).toBe("Emergency");
    expect(urgencyLabel(null)).toBe("Not sorted yet");
  });
});

describe("callsQuery", () => {
  it("sends nothing when nothing is filtered", () => {
    expect(callsQuery(NO_FILTERS)).toBe("");
  });

  it("turns UK dates into the instants the API wants, end date included", () => {
    const query = new URLSearchParams(
      callsQuery({ urgency: "urgent", from: "2026-10-24", to: "2026-10-25", needsReply: false }),
    );
    expect(query.get("urgency")).toBe("urgent");
    // 24 October is BST: UK midnight is 23:00 UTC the day before.
    expect(query.get("from")).toBe("2026-10-23T23:00:00.000Z");
    // The clocks go back on the 25th, so the day after starts at midnight UTC.
    expect(query.get("to")).toBe("2026-10-26T00:00:00.000Z");
  });

  it("keeps the filters in the page's address and reads them back, ignoring anything invalid", () => {
    const filters = { urgency: "urgent", from: "2026-11-01", to: "2026-11-07", needsReply: true };
    const search = searchFromFilters(filters);
    expect(search.toString()).toBe("urgency=urgent&from=2026-11-01&to=2026-11-07&needsReply=1");
    expect(filtersFromSearch(search)).toEqual(filters);
    expect(searchFromFilters(NO_FILTERS).toString()).toBe("");
    expect(
      filtersFromSearch(new URLSearchParams("urgency=loud&from=yesterday&needsReply=yes&x=1")),
    ).toEqual(NO_FILTERS);
  });

  it("asks for only the calls still needing a reply when that box is ticked", () => {
    expect(callsQuery({ ...NO_FILTERS, needsReply: true })).toBe("needsReply=true");
  });

  it("adds the cursor for the next page", () => {
    expect(callsQuery(NO_FILTERS, "2026-11-02T09:00:00.000Z")).toBe(
      "before=2026-11-02T09%3A00%3A00.000Z",
    );
  });
});

describe("billingSummary", () => {
  it("says the plan and how billing stands, in a few words and no amounts", () => {
    expect(billingSummary({ isPilot: false, directDebit: "none", lastCharge: null })).toBe(
      "Plan · no Direct Debit",
    );
    expect(billingSummary({ isPilot: true, directDebit: "active", lastCharge: "paid_out" })).toBe(
      "Pilot · Direct Debit set up · last month: paid",
    );
    expect(billingSummary({ isPilot: false, directDebit: "ended", lastCharge: "failed" })).toBe(
      "Plan · Direct Debit ended · last month: payment failed",
    );
  });
});
