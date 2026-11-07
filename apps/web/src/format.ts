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
