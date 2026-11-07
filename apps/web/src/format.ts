// How values read on screen. Pure functions, tested in format.test.ts.

/** "heating_engineer" → "Heating engineer" */
export function humanise(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A call's length: "0:42", "2:05". */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * A UK number as people write it: "+447700900123" → "07700 900123". Other UK numbers lose the
 * +44 but aren't grouped (area codes vary in length). Non-UK numbers are left alone. The same
 * rule as nationalNumber() in apps/api/src/core/notifications.ts, so texts and pages agree.
 */
export function formatPhone(e164: string): string {
  if (!e164.startsWith("+44")) return e164;
  const national = `0${e164.slice(3)}`;
  return national.length === 11 && national.startsWith("07")
    ? `${national.slice(0, 5)} ${national.slice(5)}`
    : national;
}

/**
 * A mobile number as people type it, in the form the API stores: "07700 900123",
 * "+44 7700 900123" and "0044 7700 900123" all become "+447700900123". Anything else comes
 * back with only its spaces removed, for the schema to refuse with a proper message.
 */
export function toUkMobileE164(typed: string): string {
  const compact = typed.replace(/[\s()-]/g, "");
  if (/^07\d{9}$/.test(compact)) return `+44${compact.slice(1)}`;
  if (/^447\d{9}$/.test(compact)) return `+${compact}`;
  if (/^00447\d{9}$/.test(compact)) return `+${compact.slice(2)}`;
  return compact;
}

export const URGENCY_LABELS: Record<string, string> = {
  emergency: "Emergency",
  urgent: "Urgent",
  routine: "Routine",
  spam: "Spam",
  other: "Other",
};

export function urgencyLabel(urgency: string | null): string {
  return urgency === null ? "Not sorted yet" : (URGENCY_LABELS[urgency] ?? humanise(urgency));
}
