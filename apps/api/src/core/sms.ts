// SMS text rules (BUILD_PLAN Step 6). A text that contains any character outside the GSM-7
// alphabet (an emoji, a curly quote, an em dash) is sent as UCS-2: 70 characters per segment
// instead of 160, and roughly double the cost. So every text we send is normalised to GSM-7
// and its segment count is known before it goes.

// The GSM 03.38 basic character set.
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// Extension characters: allowed, but each costs two septets.
const GSM7_EXTENSION = "^{}\\[~]|€";

const BASIC = new Set(GSM7_BASIC);
const EXTENSION = new Set(GSM7_EXTENSION);

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!BASIC.has(ch) && !EXTENSION.has(ch)) return false;
  return true;
}

/** Septets used by a GSM-7 text (extension characters count twice). */
function gsm7Length(text: string): number {
  let n = 0;
  for (const ch of text) n += EXTENSION.has(ch) ? 2 : 1;
  return n;
}

export interface SmsEncoding {
  encoding: "GSM-7" | "UCS-2";
  segments: number;
}

/** How a text would be sent: concatenated GSM-7 fits 153 per segment, UCS-2 fits 67. */
export function smsEncoding(text: string): SmsEncoding {
  if (isGsm7(text)) {
    const length = gsm7Length(text);
    return { encoding: "GSM-7", segments: length <= 160 ? 1 : Math.ceil(length / 153) };
  }
  const length = [...text].length;
  return { encoding: "UCS-2", segments: length <= 70 ? 1 : Math.ceil(length / 67) };
}

const REPLACEMENTS: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
};

/**
 * Rewrites a text so it sends as GSM-7: typographic quotes and dashes become plain ones,
 * accented letters lose their accents, and anything else outside the alphabet is dropped.
 */
export function toGsm7(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    if (BASIC.has(ch) || EXTENSION.has(ch)) out += ch;
    else if (ch in REPLACEMENTS) out += REPLACEMENTS[ch];
    else {
      const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (plain !== ch && isGsm7(plain)) out += plain;
      // otherwise dropped: emoji, symbols, scripts GSM-7 can't carry
    }
  }
  return out;
}
