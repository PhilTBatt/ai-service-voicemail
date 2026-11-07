// The two things the agent must never do (CLAUDE.md): quote prices and commit to times. One
// list, used twice: the API scans what the agent said after each call (core/guardrails.ts),
// and the profile editor refuses tenant-written text the agent would read out (profile.ts).

export const PRICE_PATTERNS: RegExp[] = [
  /£\s?\d/, // £80, £ 80
  /\d+\s?(?:pounds?|quid)\b/i,
  /\b(?:ninety|eighty|seventy|sixty|fifty|forty|thirty|twenty|hundred|thousand)\b[^.]{0,20}\b(?:pounds?|quid)\b/i,
  /\b(?:call-?out (?:fee|charge) (?:is|of|would be))\b/i,
  /\b(?:it(?:'ll| will) (?:cost|be) (?:about |around |roughly )?(?:£|\d))/i,
  /\b(?:costs?|charges?|rates?) (?:is|are|would be|start(?:s)? (?:at|from)) (?:about |around |roughly )?(?:£|\d)/i,
  /\bper hour\b.{0,10}\d|\d.{0,10}\bper hour\b/i,
  /\bfree of charge\b|\bno charge\b|\bwon't charge\b/i,
];

export const COMMITMENT_PATTERNS: RegExp[] = [
  /\b(?:he|she|they|[A-Z][a-z]+)(?: will| ?'ll| can| could) (?:be (?:there|with you|round|out)|come(?: round| out)?|visit|pop (?:round|over|in)|call (?:you )?back)\b[^.]{0,40}\b(?:today|tomorrow|tonight|this (?:morning|afternoon|evening)|within (?:the|an?) (?:hour|\d+ (?:hours|minutes))|in (?:an?|\d+) (?:hour|hours|minutes)|at \d|by \d|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
  /\b(?:i(?:'ll| will) book|i(?:'ve| have) booked|booked you in|book you in|put you in (?:for|the diary))\b/i,
  /\b(?:appointment|slot|visit) (?:is |for |at |on |will be )+(?:\d|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  /\b(?:guarantee|promise)\b[^.]{0,30}\b(?:today|tomorrow|tonight|within|by \d|an hour)\b/i,
  /\bwithin (?:the|an?) hour\b|\bwithin \d+ (?:minutes|hours)\b/i,
];

/** True when the text names a price, a rate, or "free of charge". */
export function mentionsPrice(text: string): boolean {
  return PRICE_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when the text promises a time: "within the hour", "Sam will be there today". */
export function promisesTime(text: string): boolean {
  return COMMITMENT_PATTERNS.some((pattern) => pattern.test(text));
}
