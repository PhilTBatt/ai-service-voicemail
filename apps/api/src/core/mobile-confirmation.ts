// Confirming a notification mobile by texted code (PROGRESS open question 4, Phil 2026-11-11):
// the bits with no database in them. A new mobile typed into the Account page gets a 6-digit code
// by text, and takes effect only once the code is typed back: a typo can't send a business's
// call texts to a stranger, and a mobile is only ever someone's who holds the phone.
import { createHash, randomInt } from "node:crypto";
import { MOBILE_CODE_LENGTH } from "@callmate/shared";
import { smsEncoding, toGsm7 } from "./sms.ts";

/** How long a code is good for. Long enough for a slow text, short enough that guessing is pointless. */
export const MOBILE_CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses allowed per code: a million codes against five tries is no odds at all. */
export const MOBILE_CODE_MAX_ATTEMPTS = 5;
/** Codes a business may ask for in an hour: each one is a text we pay for. */
export const MOBILE_CODES_PER_HOUR = 3;

/** A fresh code: digits only, leading zeros kept, from the OS's random source. */
export function newMobileCode(): string {
  return String(randomInt(0, 10 ** MOBILE_CODE_LENGTH)).padStart(MOBILE_CODE_LENGTH, "0");
}

/**
 * What's stored instead of the code. Salted with the business's ID, so the same code for two
 * businesses doesn't hash the same; with only a million codes the hash is no secret against
 * someone who can read the table, which is the point of the attempt limit, not the hash.
 */
export function hashMobileCode(code: string, tenantId: string): string {
  return createHash("sha256").update(`${tenantId}:${code}`).digest("hex");
}

/** The text that carries the code: one GSM-7 segment, nothing to tap, no link. */
export function mobileCodeSms(code: string): { body: string; segments: number } {
  const body = toGsm7(
    `AnswerMate: ${code} is your code to confirm this mobile for texts about your calls. It expires in 10 minutes. If you didn't ask for this, ignore it.`,
  );
  return { body, segments: smsEncoding(body).segments };
}
