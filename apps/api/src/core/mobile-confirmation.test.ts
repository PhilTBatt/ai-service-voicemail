import { describe, expect, it } from "vitest";
import {
  MOBILE_CODES_PER_HOUR,
  MOBILE_CODE_MAX_ATTEMPTS,
  MOBILE_CODE_TTL_MS,
  hashMobileCode,
  mobileCodeSms,
  newMobileCode,
} from "./mobile-confirmation.ts";
import { isGsm7, smsEncoding } from "./sms.ts";

describe("newMobileCode", () => {
  it("is six digits, leading zeros kept, and not the same every time", () => {
    const codes = new Set(Array.from({ length: 50 }, () => newMobileCode()));
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("hashMobileCode", () => {
  it("is the same for the same code and business, and different across businesses", () => {
    expect(hashMobileCode("123456", "tenant-a")).toBe(hashMobileCode("123456", "tenant-a"));
    expect(hashMobileCode("123456", "tenant-a")).not.toBe(hashMobileCode("123456", "tenant-b"));
    expect(hashMobileCode("123456", "tenant-a")).not.toBe(hashMobileCode("123457", "tenant-a"));
    expect(hashMobileCode("123456", "tenant-a")).not.toContain("123456");
  });
});

describe("mobileCodeSms", () => {
  it("carries the code in one GSM-7 segment, says what it's for and how long it lasts, with no link", () => {
    const { body, segments } = mobileCodeSms("042517");
    expect(body).toContain("042517");
    expect(body).toContain("confirm this mobile");
    expect(body).toContain("10 minutes");
    expect(body).not.toMatch(/https?:/);
    expect(isGsm7(body)).toBe(true);
    expect(segments).toBe(1);
    expect(smsEncoding(body).segments).toBe(1);
  });
});

describe("the limits", () => {
  it("give a code ten minutes, five tries, and three codes an hour", () => {
    expect(MOBILE_CODE_TTL_MS).toBe(10 * 60_000);
    expect(MOBILE_CODE_MAX_ATTEMPTS).toBe(5);
    expect(MOBILE_CODES_PER_HOUR).toBe(3);
  });
});
