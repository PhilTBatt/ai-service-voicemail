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
