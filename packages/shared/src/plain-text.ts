// What a tradesperson types that reaches the assistant's prompt, or a text or email: business
// and contact names, services, areas, FAQ questions and answers. Refused (Phil, 2026-11-11):
// - line breaks and other control characters: each of these is one line, and a line break in
//   an FAQ answer could start what reads, in the prompt, as a new section of instructions;
// - invisible formatting characters (\p{Cf}): zero-width spaces and joiners, the marks that
//   reverse the direction of text (so a name could display as something other than what's
//   stored), a byte-order mark, a soft hyphen. They usually arrive by copy and paste;
// - text with no letter or digit in it, including text that's only invisible characters.
// One message per problem, said as the person would understand it. Tested in plain-text.test.ts.

const CONTROL = /\p{Cc}/u;
const INVISIBLE = /\p{Cf}/u;
const VISIBLE = /[\p{L}\p{N}]/u;

/**
 * Why this text can't be used, or null when it can. Empty text is left to the field's own
 * length rule ("can't be empty"), so the person reads one message, not two.
 */
export function plainTextProblem(value: string): string | null {
  if (value === "") return null;
  if (/[\r\n\u2028\u2029]/.test(value)) return "keep it on one line";
  if (CONTROL.test(value)) return "has a hidden character in it: please retype it";
  if (INVISIBLE.test(value)) {
    return "has a hidden character in it (often from copying and pasting): please retype it";
  }
  if (!VISIBLE.test(value)) return "needs some words";
  return null;
}
