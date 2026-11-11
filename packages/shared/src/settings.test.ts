// The settings rules the dashboard and the API share. The email cap: an address longer than RFC
// 5321 allows was saved, and the email provider would then have refused it on every send.
import { describe, expect, it } from "vitest";
import { EMAIL_MAX_LENGTH, notificationSettingsSchema } from "./settings.ts";
import { signupInputSchema } from "./signup.ts";

/** A well-formed address at a subdomain of example.com: 215 characters plus the last label. */
const addressWithLastLabel = (characters: number) =>
  `sam.caller@${["d".repeat(63), "d".repeat(63), "d".repeat(63), "d".repeat(characters)].join(".")}.example.com`;
const LONGEST = addressWithLastLabel(39);
const ONE_TOO_LONG = addressWithLastLabel(40);

const SIGNUP = {
  code: "c".repeat(32),
  businessName: "Sam's Plumbing",
  trade: "plumber",
  contactName: "Sam",
  mobile: "+447700900123",
  mobileNetwork: "o2",
  usesNetworkVoicemail: false,
  accepted: { terms: "v1", dpa: "v1", privacy_notice: "v1" },
};

describe("email addresses", () => {
  it("are built to the lengths the tests mean", () => {
    expect(EMAIL_MAX_LENGTH).toBe(254);
    expect(LONGEST).toHaveLength(254);
    expect(ONE_TOO_LONG).toHaveLength(255);
  });

  it("take the longest address RFC 5321 allows as the notification email", () => {
    const parsed = notificationSettingsSchema.safeParse({
      notificationMobile: null,
      notificationEmail: LONGEST,
    });
    expect(parsed.success).toBe(true);
  });

  it("refuse a notification email one character longer, saying how long it may be", () => {
    const parsed = notificationSettingsSchema.safeParse({
      notificationMobile: null,
      notificationEmail: ONE_TOO_LONG,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["notificationEmail"],
        message: "keep it to 254 characters or fewer",
      }),
    ]);
  });

  it("hold the signup form's email to the same limit", () => {
    expect(signupInputSchema.safeParse({ ...SIGNUP, email: LONGEST }).success).toBe(true);
    const parsed = signupInputSchema.safeParse({ ...SIGNUP, email: ONE_TOO_LONG });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["email"],
        message: "keep it to 254 characters or fewer",
      }),
    ]);
    // Leaving it empty still means "the address I signed in with".
    expect(signupInputSchema.safeParse({ ...SIGNUP, email: null }).success).toBe(true);
  });
});
