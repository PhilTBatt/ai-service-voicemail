// The two things the agent must never do (CLAUDE.md): quote prices and commit to times. One
// list, used twice: the API scans what the agent said after each call (core/guardrails.ts),
// and the profile editor refuses tenant-written text the agent would read out (profile.ts).
// The scan only queues a call for review, so it errs towards flagging; the editor shares the
// lists, so they stay clear of everyday wording ("free quotes", "24 hours a day", "he'll
// call you back as soon as he can") and of the agent's own deflections ("I can't book you in").

const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
/** An amount, written or spoken: 80, £80, 1,200, eighty, a hundred and twenty. */
const AMOUNT = `(?:£\\s?\\d[\\d,.]*|\\d[\\d,.]*|(?:an? )?(?:${NUMBER_WORDS})(?:(?:[\\s-]|\\sand\\s)(?:${NUMBER_WORDS}))*)`;
const ABOUT = "(?:about |around |roughly |only |just |approximately )?";
const CALL_OUT = "call[- ]?out";

export const PRICE_PATTERNS: RegExp[] = [
  /£\s?\d/, // £80, £ 80
  /\d+\s?(?:pounds?|quid)\b/i,
  new RegExp(`\\b(?:${NUMBER_WORDS})\\b[^.]{0,20}\\b(?:pounds?|quid)\\b`, "i"), // fifteen quid
  new RegExp(`\\b(?:a|\\d+|${NUMBER_WORDS})\\s+grand\\b`, "i"), // two grand
  /\b\d+(?:\.\d+)?k\b/, // 8k (lower case only: "4K" is a television)
  // The call-out fee with a figure. Without one ("Ant will tell you the call-out fee") it's fine.
  new RegExp(
    `\\b${CALL_OUT}(?: fee| charge)?(?:'s| is| of| would be| costs?| will be)\\s+${ABOUT}${AMOUNT}`,
    "i",
  ),
  new RegExp(`${AMOUNT}\\b[^.]{0,15}\\bfor (?:the |a )?${CALL_OUT}\\b`, "i"), // eighty for the call-out
  /\b(?:it(?:'ll| will) (?:cost|be) (?:about |around |roughly )?(?:£|\d))/i,
  new RegExp(
    `\\b(?:costs?|charges?|rates?|prices?)\\s+(?:is|are|would be|will be|starts?|starting)\\s+(?:at |from )?${ABOUT}(?:£|\\d|(?:${NUMBER_WORDS})\\b)`,
    "i",
  ),
  new RegExp(`\\bcharges?\\s+${ABOUT}(?:£|\\d)`, "i"), // he charges 45
  new RegExp(`${AMOUNT}\\s*(?:an?|per|\\/)\\s*(?:hour|hr)\\b`, "i"), // 45 an hour, 45/hr
  /\bper hour\b.{0,10}\d|\d.{0,10}\bper hour\b/i,
  /\b(?:plus|\+|excluding|ex\.?|including|inc\.?)\s*VAT\b/i,
  new RegExp(
    `\\bfree of charge\\b|\\bno (?:${CALL_OUT} )?(?:charge|fee)\\b|\\bwon't charge\\b`,
    "i",
  ),
];

const TIME_WORDS = `(?:today|tomorrow|tonight|this (?:morning|afternoon|evening|arvo)|first thing|shortly|next week|(?:on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: morning| afternoon| evening)?|within (?:the next |the |next )?(?:(?:an?|half an|\\d+|${NUMBER_WORDS}) ?)?(?:hours?|minutes|mins)|in (?:about |around )?(?:an?|half an|\\d+|${NUMBER_WORDS}) ?(?:hours?|minutes|mins)|at (?:\\d|(?:${NUMBER_WORDS})\\b)|by (?:\\d|(?:${NUMBER_WORDS})\\b))`;
/** Who'd be committed to: a pronoun, or any name. */
const WHO = "(?:he|she|they|we|someone|somebody|an engineer|the engineer|[A-Z][a-z]+)";
const ACTION =
  "(?:(?: will| ?'ll| can| could| should| would| is going to| are going to|'s going to) (?:be (?:there|with you|round|out|over)|come(?: round| out| over)?|visit|pop (?:round|over|in)|(?:call|ring|phone|bell) (?:you )?back|get back to you|give you a (?:ring|call|bell))|(?:'s| is| are) (?:coming|popping)(?: round| out| over)?)";
const NEGATION = "(?:can't|cannot|can not|won't|will not|unable to|not able to|don't|do not)";
/** Not straight after "I can't promise", "I can't say when"... in the same clause: a deflection. */
const NOT_DEFLECTED = `(?<!\\b${NEGATION}\\s+(?:promise|guarantee|say|confirm|tell you)\\b[^.!?,;]*)`;

export const COMMITMENT_PATTERNS: RegExp[] = [
  new RegExp(`${NOT_DEFLECTED}\\b${WHO}${ACTION}\\b[^.]{0,40}\\b${TIME_WORDS}\\b`, "i"),
  new RegExp(
    `(?<!\\b${NEGATION}\\s+)\\b(?:i(?:'ll| will) book|i(?:'ve| have) booked|booked you in|book you in|put you in (?:for|the diary)|pencil(?:led)? you in)\\b`,
    "i",
  ),
  /\b(?:appointment|slot|visit) (?:is |for |at |on |will be )+(?:\d|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  new RegExp(
    `(?<!\\b${NEGATION}\\s+)\\b(?:guarantee|promise)\\b[^.]{0,30}\\b(?:today|tomorrow|tonight|within|by \\d|an hour)\\b`,
    "i",
  ),
  new RegExp(
    `${NOT_DEFLECTED}\\bwithin (?:the next |the |next )?(?:(?:an?|half an|\\d+|${NUMBER_WORDS}) ?)?(?:hours?|minutes|mins)\\b`,
    "i",
  ),
  /\bexpect (?:a|his|her|their) call\b[^.]{0,30}\b(?:within|in|by|today|tomorrow|this)\b/i,
];

/**
 * Safety advice: the agent gives only Appendix A's messages, word for word, so a profile may
 * not add its own ("turn the gas off at the meter", "open the windows").
 */
export const SAFETY_ADVICE_PATTERNS: RegExp[] = [
  /\bturn (?:it|them|the (?:gas|water|electrics?|electricity|power|supply|mains|meter)|your (?:gas|water|electrics?|power|supply|mains|stopcock|meter))(?: supply)? off\b/i,
  /\bturn off (?:the |your )?(?:gas|water|electrics?|electricity|power|supply|mains|stopcock|meter)\b/i,
  /\bopen (?:the |all |your |some )?(?:doors|windows)\b/i,
  /\b(?:don't|do not|never) (?:use|touch|press|flick) (?:any )?(?:light |electrical )?switch(?:es)?\b/i,
  /\b(?:evacuate|leave the (?:house|property|building|premises))\b/i,
  /\bisolate (?:the |your )?(?:supply|power|water|gas|circuit|mains)\b/i,
];

/** True when the text names a price, a rate, or "free of charge". */
export function mentionsPrice(text: string): boolean {
  return PRICE_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when the text promises a time: "within the hour", "Sam will be there today". */
export function promisesTime(text: string): boolean {
  return COMMITMENT_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when the text gives safety advice of its own. */
export function givesSafetyAdvice(text: string): boolean {
  return SAFETY_ADVICE_PATTERNS.some((pattern) => pattern.test(text));
}
