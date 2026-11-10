/**
 * An E.164 number, or null for anything else: Twilio sends "anonymous", "+266696687" and
 * similar placeholders when the caller withholds their number.
 */
export function e164OrNull(value: string | null | undefined): string | null {
  return value !== undefined &&
    value !== null &&
    /^\+[1-9]\d{7,14}$/.test(value) &&
    value !== "+266696687"
    ? value
    : null;
}

/**
 * A UK mobile as a person types it ("07700 900123", "+44 (0)7700-900123", "447700900123"),
 * as the E.164 form texts are sent to (+447 and nine digits), or null for anything else.
 */
export function ukMobileFromInput(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  let digits = value.replace(/[\s().-]/g, "");
  // "+44 (0)7700 900123" is "+4407700900123" by now: the 0 is the trunk prefix, not a digit.
  if (digits.startsWith("+440")) digits = `+44${digits.slice(4)}`;
  if (digits.startsWith("0")) digits = `+44${digits.slice(1)}`;
  else if (digits.startsWith("44")) digits = `+${digits}`;
  return /^\+447\d{9}$/.test(digits) ? digits : null;
}
