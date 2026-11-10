import { describe, expect, it } from "vitest";
import { Spike } from "./spike.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 12, minutes));

describe("Spike", () => {
  it("fires on the event that takes the window past the limit, and not before", () => {
    const spike = new Spike({ limit: 2, windowMs: 15 * 60_000 });
    expect(spike.record(at(0))).toBe(false);
    expect(spike.record(at(1))).toBe(false);
    expect(spike.record(at(2))).toBe(true);
    expect(spike.count).toBe(3);
  });

  it("fires once per burst: not again until a window has passed since the alert", () => {
    const spike = new Spike({ limit: 2, windowMs: 15 * 60_000 });
    for (const minute of [0, 1, 2]) spike.record(at(minute));
    expect(spike.record(at(3))).toBe(false);
    expect(spike.record(at(14))).toBe(false);
    // Still over the limit a window later, so it says so again.
    expect(spike.record(at(17))).toBe(true);
  });

  it("forgets events older than the window", () => {
    const spike = new Spike({ limit: 2, windowMs: 15 * 60_000 });
    spike.record(at(0));
    spike.record(at(1));
    expect(spike.record(at(16))).toBe(false); // the two from before have aged out
    expect(spike.count).toBe(1);
    expect(spike.record(at(17))).toBe(false);
    expect(spike.record(at(18))).toBe(true);
  });
});
