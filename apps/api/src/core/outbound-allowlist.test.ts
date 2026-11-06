import { describe, expect, it } from "vitest";
import { checkOutbound, parseAllowlist } from "./outbound-allowlist.ts";

const allowlist = parseAllowlist(" +447700900001, Phil@Example.com ,,");

describe("checkOutbound", () => {
  it("allows everything in production", () => {
    expect(checkOutbound({ nodeEnv: "production", allowlist }, "+447700900999")).toEqual({
      allowed: true,
    });
  });

  it.each(["development", "test"] as const)("in %s, allows only the allowlist", (nodeEnv) => {
    expect(checkOutbound({ nodeEnv, allowlist }, "+447700900001")).toEqual({ allowed: true });
    expect(checkOutbound({ nodeEnv, allowlist }, "phil@example.com")).toEqual({ allowed: true });
    expect(checkOutbound({ nodeEnv, allowlist }, "+447700900999")).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("OUTBOUND_ALLOWLIST") as unknown,
    });
  });

  it("matches case-insensitively and ignores surrounding spaces", () => {
    expect(checkOutbound({ nodeEnv: "development", allowlist }, " PHIL@example.com ")).toEqual({
      allowed: true,
    });
  });

  it("blocks everything outside production when the allowlist is empty", () => {
    expect(
      checkOutbound(
        { nodeEnv: "development", allowlist: parseAllowlist(undefined) },
        "+447700900001",
      ),
    ).toMatchObject({ allowed: false });
  });
});
