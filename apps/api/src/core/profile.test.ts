import { describe, expect, it } from "vitest";
import { openingHoursSchema } from "./profile.ts";

describe("openingHoursSchema", () => {
  it("accepts a day's slot and a closed day", () => {
    expect(
      openingHoursSchema.safeParse({ mon: { open: "08:00", close: "18:00" }, sun: null }).success,
    ).toBe(true);
  });

  // Overnight hours (the watch list, 2026-11-13): a slot that closes earlier than it opens runs
  // into the next morning. The same time twice could mean no time or all day, so it's refused.
  it("accepts a slot that runs overnight, and refuses one that opens and closes at the same time", () => {
    expect(openingHoursSchema.safeParse({ fri: { open: "22:00", close: "02:00" } }).success).toBe(
      true,
    );
    const same = openingHoursSchema.safeParse({ fri: { open: "09:00", close: "09:00" } });
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]?.message).toContain("can't open and close at the same time");
  });

  it("rejects times that aren't HH:MM", () => {
    expect(openingHoursSchema.safeParse({ mon: { open: "8am", close: "6pm" } }).success).toBe(
      false,
    );
  });
});
