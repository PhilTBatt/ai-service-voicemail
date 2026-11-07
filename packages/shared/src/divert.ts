// Divert instructions (BUILD_PLAN Step 11, Appendix C): how a tradesperson sends the calls
// they miss to their AnswerMate number, for their mobile network. Shared so the dashboard's
// Phone setup page and the text the worker sends say exactly the same thing.
//
// The codes come from secondary sources (the plan says so), which is why every set of
// instructions ends with the check code and a test call: the divert has to be seen working.
import type { MobileNetwork } from "./signup.ts";

/** No answer, busy, unreachable: the three conditional diverts. */
export interface DivertCode {
  when: string;
  turnOn: string;
  check: string;
  turnOff: string;
}

export interface DivertInstructions {
  /** "dial": dial the codes. "settings": the network may not take the code, so try it, then use the phone's settings. */
  method: "dial" | "settings";
  codes: DivertCode[];
  /** Network-specific advice, in words. */
  notes: string[];
  /** Dials the network's own voicemail back in, for leaving AnswerMate; null when we don't know it. */
  restoreVoicemail: string | null;
}

/** The ring-time part of the no-answer code, by network (Appendix C's network notes). */
function noAnswerCode(network: MobileNetwork | null, number: string): string {
  switch (network) {
    case "three":
    case "id_mobile":
    case "smarty":
    case "ee":
    case "lyca":
    case "bt_mobile":
      return `**61*${number}#`;
    default:
      return `**61*${number}*11*20#`;
  }
}

function notesFor(network: MobileNetwork | null): string[] {
  switch (network) {
    case "vodafone":
    case "voxi":
    case "lebara":
      return [
        "If your phone says the no-answer code failed, try it with *10* in place of *11*: sources disagree on which this network uses.",
      ];
    case "ee":
    case "lyca":
    case "bt_mobile":
      return [
        "This network may not accept a ring time in the code, so the no-answer code here leaves it out.",
        "If your phone says it failed, set it in your phone instead: on Android, Phone, then Settings, Calls, Call forwarding, When unanswered. Or ask your network to divert unanswered calls to your AnswerMate number.",
      ];
    case "three":
    case "id_mobile":
    case "smarty":
      return [
        "This network rings for about 15 seconds before diverting; it doesn't take a ring time.",
      ];
    case "other":
    case null:
      return [
        "If your phone says a code failed, ask your network to divert unanswered, busy and unreachable calls to your AnswerMate number.",
      ];
    default:
      return [];
  }
}

const RESTORE_VOICEMAIL: Partial<Record<MobileNetwork, string>> = {
  o2: "**61*901#",
  vodafone: "**61*121*11*30#",
  ee: "**61*+447953222222*11*30#",
};

/** Cancels the no-answer, busy and unreachable diverts, in that order (Appendix C). */
export const DIVERT_TURN_OFF_CODES = ["##61#", "##67#", "##62#"] as const;

/** The code that brings a network's voicemail back (Appendix C), or null when we don't know it. */
export function voicemailRestoreCode(network: MobileNetwork | null): string | null {
  return network ? (RESTORE_VOICEMAIL[network] ?? null) : null;
}

/**
 * The instructions for `network` (null when we don't know it) and the business's AnswerMate
 * number, which must be in +44 form: the codes need the international format.
 */
export function divertInstructions(
  network: MobileNetwork | null,
  answermateNumber: string,
): DivertInstructions {
  if (!/^\+44\d{9,10}$/.test(answermateNumber)) {
    throw new Error(`Divert codes need a UK number in +44 form, got "${answermateNumber}"`);
  }
  const method =
    network === "ee" || network === "lyca" || network === "bt_mobile" ? "settings" : "dial";
  return {
    method,
    codes: [
      {
        when: "When you don't answer",
        turnOn: noAnswerCode(network, answermateNumber),
        check: "*#61#",
        turnOff: "##61#",
      },
      {
        when: "When you're on another call or decline it",
        turnOn: `**67*${answermateNumber}#`,
        check: "*#67#",
        turnOff: "##67#",
      },
      {
        when: "When your phone is off or has no signal",
        turnOn: `**62*${answermateNumber}#`,
        check: "*#62#",
        turnOff: "##62#",
      },
    ],
    notes: [
      ...notesFor(network),
      'If you\'ve ever set "divert all calls", cancel it first with ##21#: it overrides these.',
      "These replace your network's voicemail: callers you miss reach AnswerMate instead.",
    ],
    restoreVoicemail: voicemailRestoreCode(network),
  };
}

/** The text the worker sends: the main code, the check, the test, and where the full steps are. */
export function divertInstructionsText(
  network: MobileNetwork | null,
  answermateNumber: string,
  fullStepsUrl: string,
): string {
  const { codes, method } = divertInstructions(network, answermateNumber);
  const noAnswer = codes[0]!;
  const fallback =
    method === "settings" ? " If it fails, the page below shows how to set it in your phone." : "";
  return (
    `AnswerMate: to send calls you miss to your assistant, dial ${noAnswer.turnOn} and press call.${fallback} ` +
    `Check it with ${noAnswer.check}. Then ring your mobile from another phone and don't answer. ` +
    `Full steps: ${fullStepsUrl}`
  );
}
