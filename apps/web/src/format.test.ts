import { describe, expect, it } from "vitest";
import { callsQuery, NO_FILTERS } from "./calls-query.ts";
import { formatDuration, formatPhone, humanise, urgencyLabel } from "./format.ts";

describe("format", () => {
  it("humanises stored values", () => {
    expect(humanise("heating_engineer")).toBe("Heating engineer");
    expect(humanise("live")).toBe("Live");
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
      callsQuery({ urgency: "urgent", from: "2026-10-24", to: "2026-10-25" }),
    );
    expect(query.get("urgency")).toBe("urgent");
    // 24 October is BST: UK midnight is 23:00 UTC the day before.
    expect(query.get("from")).toBe("2026-10-23T23:00:00.000Z");
    // The clocks go back on the 25th, so the day after starts at midnight UTC.
    expect(query.get("to")).toBe("2026-10-26T00:00:00.000Z");
  });

  it("adds the cursor for the next page", () => {
    expect(callsQuery(NO_FILTERS, "2026-11-02T09:00:00.000Z")).toBe(
      "before=2026-11-02T09%3A00%3A00.000Z",
    );
  });
});
