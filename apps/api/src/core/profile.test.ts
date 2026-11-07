import { describe, expect, it } from "vitest";
import { openingHoursSchema } from "./profile.ts";

describe("openingHoursSchema", () => {
  it("accepts a day's slot and a closed day", () => {
    expect(
      openingHoursSchema.safeParse({ mon: { open: "08:00", close: "18:00" }, sun: null }).success,
    ).toBe(true);
  });

  it("rejects a slot that closes before it opens, since overnight hours aren't supported yet", () => {
    const result = openingHoursSchema.safeParse({ fri: { open: "22:00", close: "02:00" } });
    expect(result.success).toBe(false);
    expect(openingHoursSchema.safeParse({ fri: { open: "09:00", close: "09:00" } }).success).toBe(
      false,
    );
  });

  it("rejects times that aren't HH:MM", () => {
    expect(openingHoursSchema.safeParse({ mon: { open: "8am", close: "6pm" } }).success).toBe(
      false,
    );
  });
});
