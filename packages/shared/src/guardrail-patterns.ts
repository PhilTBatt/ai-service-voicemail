// The things the agent must never do (CLAUDE.md): quote prices, commit to times, and give safety
// advice beyond the approved scripts. One list each, used twice: the API scans what the agent
// said after each call (core/guardrails.ts), and the profile editor refuses tenant-written text
// the agent would read out (profile.ts).
// The scan only queues a call for review, so it errs towards flagging; the editor shares the
// lists, so they stay clear of everyday wording ("free quotes", "24 hours a day", "he'll
// call you back as soon as he can") and of the agent's own deflections ("I can't book you in").

/**
 * The text as the patterns read it. NFKC turns look-alikes into the characters the patterns are
 * written with: a full-width "￡５０" is "£50". Invisible format characters (a zero-width space,
 * a soft hyphen) are dropped, curly apostrophes made straight, and each run of whitespace made
 * one space, which also keeps the patterns' lookbehinds from rescanning a long run at every
 * position (a 50,000-space turn took 17 seconds).
 */
export function guardrailText(text: string): string {
  return text
    .normalize("NFKC")
    .replaceAll(/\p{Cf}/gu, "")
    .replaceAll(/[‘’]/g, "'")
    .replaceAll(/\s+/g, " ");
}

const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
/**
 * An amount, written or spoken: 80, £80, 1,200, eighty, a hundred and twenty. Bounded: no price
 * is longer, and an unbounded run let a turn of 50,000 digits or number words take seconds per
 * pattern, every start position running to the end of it. A longer run still matches at its end.
 */
const AMOUNT = `(?:£\\s?\\d[\\d,.]{0,15}|\\d[\\d,.]{0,15}|(?:an? )?(?:${NUMBER_WORDS})(?:(?:[\\s-]|\\sand\\s)(?:${NUMBER_WORDS})){0,8})`;
const ABOUT = "(?:about |around |roughly |only |just |approximately )?";
const CALL_OUT = "call[- ]?out";

export const PRICE_PATTERNS: RegExp[] = [
  /£\s?\d/, // £80, £ 80
  // Only from the start of the digits: from every one, a long run of them took seconds.
  /(?<!\d)\d+\s?(?:pounds?|quid)\b/i,
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
/**
 * Not straight after "I can't promise", "I can't say when"... in the same clause: a deflection.
 * Within 80 characters of it: an unbounded look back went to the start of the clause from every
 * position, and a 34,000-character turn with no punctuation took seconds. A deflection further
 * back than that is flagged, which only means a person reads it.
 */
const NOT_DEFLECTED = `(?<!\\b${NEGATION}\\s+(?:promise|guarantee|say|confirm|tell you)\\b[^.!?,;]{0,80})`;

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

const SUPPLY = "(?:gas|water|electrics?|electricity|power|supply|mains|meter|boiler|socket)";
// Not advice, though the words are there. Each ends where the advice verb starts.
/** The agent declining: "I can't advise you to turn it off", "I can't say whether to unplug it". */
const DECLINED =
  "(?:can't|cannot|can not|not able to|unable to|won't)\\s+(?:say|tell(?:\\s+you)?|advise(?:\\s+(?:you|on))?|recommend|confirm)\\s+(?:(?:whether|if)\\s+(?:(?:you\\s+should|you\\s+need\\s+to|it's\\s+safe\\s+to|to)\\s+)?|to\\s+)?";
/** The agent deferring: "Ant will tell you whether to turn it off". */
const DEFERRED =
  "(?:will|'ll)\\s+(?:advise(?:\\s+you)?|tell\\s+you|say|let\\s+you\\s+know)\\s+(?:whether|if)\\s+(?:(?:you\\s+should|to)\\s+)?";
/** A question about what the caller managed: "were you able to turn the water off?" */
const ASKED = "(?:(?:able|managed)\\s+to|did\\s+you|(?:you|they)\\s+(?:can't|cannot|couldn't))\\s+";
/** What the tradesperson does on the job: "he'll turn the water off", "we switch the power off". */
const THE_TRADE_DOES = "(?:we|he|she|they)(?:'ll|\\s+will|\\s+can|\\s+may|\\s+would)?\\s+";
const NOT_ADVICE = `(?<!\\b(?:${DECLINED}|${DEFERRED}|${ASKED}|${THE_TRADE_DOES}))`;
/** Which doors or windows: "the", "your", "all", "all the", "some of the". */
const WHICH = "(?:(?:all|some) (?:of )?)?(?:the |your )?";

/**
 * Safety advice: the agent gives only Appendix A's messages, word for word, so a profile may
 * not add its own ("turn the gas off at the meter", "open the windows"), and after a call the
 * agent's own words are checked for it (core/guardrails.ts, which allows the scripts
 * themselves). "If you can turn the water off, please do" is advice; "I can't advise you to
 * turn it off" isn't.
 */
export const SAFETY_ADVICE_PATTERNS: RegExp[] = [
  // "All the electrics" and "all of the power" too, as with the doors and windows below: only
  // "the" or "your" used to be allowed before the supply.
  `\\bturn (?:it|them|everything|${WHICH}(?:${SUPPLY}|stopcock))(?: supply)? off\\b`,
  `\\bturn off ${WHICH}(?:${SUPPLY}|stopcock)\\b`,
  `\\bswitch (?:it|them|everything|${WHICH}${SUPPLY})(?: supply)? off\\b`,
  `\\bswitch off ${WHICH}${SUPPLY}\\b`,
  "\\bunplug (?:it|them|everything|the (?:boiler|appliance|heater|socket))\\b",
  // "all the windows" and "all of the windows" too: one word between used to be the limit.
  `\\bopen ${WHICH}(?:doors|windows)\\b`,
  // Not "get": a locksmith gets doors open for a living.
  `\\b(?:keep|leave) ${WHICH}(?:doors|windows)(?: and (?:the )?(?:doors|windows))? open\\b`,
  "\\b(?:don't|do not|never) (?:use|touch|press|flick) (?:any |the |your )?(?:light |electrical )?switch(?:es)?\\b",
  // Only as an instruction: "Don't touch it", "Get out now", not "we don't touch gas work".
  "(?:^|[.!?,;]\\s+|\\bplease\\s+)(?:(?:don't|do not) (?:touch|go near|go back in(?:side|to)?)|get out)\\b",
  "\\b(?:evacuate|leave the (?:house|property|building|premises))\\b",
  "\\bget (?:everyone|everybody|yourself|your family|the (?:kids|children)) out\\b",
  "\\bisolate (?:the |your )?(?:supply|power|water|gas|circuit|mains)\\b",
  // The scripts' own numbers, said in the agent's words. The gas emergency numbers are
  // apps/api's GAS_EMERGENCY_NUMBER; core/guardrails.test.ts checks each one is caught.
  "\\b(?:call|ring|dial|phone) (?:999|112)\\b",
  "\\b(?:call|ring|phone|contact) (?:the )?(?:national )?gas emergency\\b",
  "\\b0800\\s?(?:111\\s?999|002\\s?001)\\b",
  "\\b(?:call|ring|dial|phone|contact) (?:the )?(?:emergency services|fire (?:brigade|service)|police|ambulance)\\b",
].map((source) => new RegExp(`${NOT_ADVICE}${source}`, "i"));

/** True when the text names a price, a rate, or "free of charge". */
export function mentionsPrice(text: string): boolean {
  const plain = guardrailText(text);
  return PRICE_PATTERNS.some((pattern) => pattern.test(plain));
}

/** True when the text promises a time: "within the hour", "Sam will be there today". */
export function promisesTime(text: string): boolean {
  const plain = guardrailText(text);
  return COMMITMENT_PATTERNS.some((pattern) => pattern.test(plain));
}

/** True when the text gives safety advice of its own. */
export function givesSafetyAdvice(text: string): boolean {
  const plain = guardrailText(text);
  return SAFETY_ADVICE_PATTERNS.some((pattern) => pattern.test(plain));
}
