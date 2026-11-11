/**
 * What Twilio puts in From when there's no caller ID: the words spelled on a phone keypad.
 * ANONYMOUS is the one seen so far; RESTRICTED and UNAVAILABLE follow the same pattern (our
 * reading of the keypad spelling, not from Twilio's docs), and each is a plausible-looking
 * E.164 number that would otherwise be texted or counted as a caller. (BLOCKED, +2562533, is
 * too short to pass as E.164 anyway.)
 */
const NO_CALLER_ID = new Set(["+266696687", "+7378742833", "+86282452253"]);

/**
 * An E.164 number, or null for anything else: Twilio sends "anonymous", "+266696687" and
 * similar placeholders when the caller withholds their number.
 */
export function e164OrNull(value: string | null | undefined): string | null {
  return value !== undefined &&
    value !== null &&
    /^\+[1-9]\d{7,14}$/.test(value) &&
    !NO_CALLER_ID.has(value)
    ? value
    : null;
}

/**
 * A UK mobile as a person types it ("07700 900123", "+44 (0)7700-900123", "447700900123",
 * "0044 7700 900123"), as the E.164 form texts are sent to (+447 and nine digits), or null for
 * anything else.
 */
export function ukMobileFromInput(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  let digits = value.replace(/[\s().-]/g, "");
  // 00 is the international prefix, as + is: "0044 7700 900123" was read as a national number
  // starting 0044 and refused.
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  else if (digits.startsWith("0")) digits = `+44${digits.slice(1)}`;
  else if (digits.startsWith("44")) digits = `+${digits}`;
  // "+44 (0)7700 900123" and "0044 (0)7700 900123" are "+4407700900123" by now: the 0 is the
  // trunk prefix, not a digit.
  if (digits.startsWith("+440")) digits = `+44${digits.slice(4)}`;
  return /^\+447\d{9}$/.test(digits) ? digits : null;
}

/**
 * Any number a caller might give, written however the extraction wrote it ("07700 900123",
 * "+44 7700 900123", "0113 496 0000", "0044 7700 900123"), as E.164, or null when it isn't
 * one. UK numbers are +44 and 9 or 10 digits; anything else must already be + and E.164.
 */
export function phoneFromInput(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  let digits = value.replace(/[\s().-]/g, "");
  if (digits.startsWith("+440")) digits = `+44${digits.slice(4)}`;
  // "7700 900123": a mobile written without its leading 0 (the extraction sometimes drops it).
  if (/^7\d{9}$/.test(digits)) digits = `+44${digits}`;
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  else if (digits.startsWith("0")) digits = `+44${digits.slice(1)}`;
  else if (digits.startsWith("44")) digits = `+${digits}`;
  // "0044 (0)7700 900123" only reads as "+440..." now: drop the trunk 0 here too.
  if (digits.startsWith("+440")) digits = `+44${digits.slice(4)}`;
  // Mobiles (07) are always 11 digits written nationally; a few landline areas have 10.
  if (digits.startsWith("+447")) return /^\+447\d{9}$/.test(digits) ? digits : null;
  if (digits.startsWith("+44")) return /^\+44\d{9,10}$/.test(digits) ? digits : null;
  return e164OrNull(digits);
}
