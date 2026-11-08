import { describe, expect, it } from "vitest";
import { divertInstructions, divertInstructionsText } from "./divert.ts";
import { MOBILE_NETWORK_KEYS, type MobileNetwork } from "./signup.ts";

// Ofcom's drama range, in the +44 form the codes need.
const NUMBER = "+441134960150";

describe("divertInstructions, for each network", () => {
  it("puts the number in +44 form, with no spaces and no leading 0, in every code", () => {
    for (const network of [...MOBILE_NETWORK_KEYS, null]) {
      const { codes } = divertInstructions(network, NUMBER);
      expect(codes.map((code) => code.turnOn).join(" "), String(network)).not.toMatch(/\*0|\s0/);
      for (const code of codes) expect(code.turnOn, String(network)).toContain("*+441134960150");
      expect(codes.map((code) => code.check)).toEqual(["*#61#", "*#67#", "*#62#"]);
      expect(codes.map((code) => code.turnOff)).toEqual(["##61#", "##67#", "##62#"]);
    }
  });

  it("uses Appendix C's no-answer code for each network", () => {
    const noAnswer = (network: MobileNetwork | null) =>
      divertInstructions(network, NUMBER).codes[0]!.turnOn;
    // O2, giffgaff, Tesco Mobile, Sky Mobile: a 20-second ring time with *11*.
    for (const network of ["o2", "giffgaff", "tesco_mobile", "sky_mobile"] as const) {
      expect(noAnswer(network), network).toBe("**61*+441134960150*11*20#");
    }
    // Vodafone, VOXI, Lebara: *11* too, with a note about *10*.
    for (const network of ["vodafone", "voxi", "lebara"] as const) {
      expect(noAnswer(network), network).toBe("**61*+441134960150*11*20#");
      expect(divertInstructions(network, NUMBER).notes.join(" ")).toContain("*10*");
    }
    // Three, iD Mobile, SMARTY: no ring time.
    for (const network of ["three", "id_mobile", "smarty"] as const) {
      expect(noAnswer(network), network).toBe("**61*+441134960150#");
    }
    // EE, Lyca, BT Mobile: no ring time, and the phone's settings if the code fails.
    for (const network of ["ee", "lyca", "bt_mobile"] as const) {
      expect(noAnswer(network), network).toBe("**61*+441134960150#");
      expect(divertInstructions(network, NUMBER).method).toBe("settings");
      // An iPhone's Call Forwarding setting is "divert everything": they must be warned off it.
      expect(divertInstructions(network, NUMBER).notes.join(" ")).toContain(
        "On an iPhone, don't use",
      );
    }
    expect(divertInstructions("o2", NUMBER).method).toBe("dial");
    // Unknown network: the common form, and "ask your network" if it fails.
    expect(noAnswer(null)).toBe("**61*+441134960150*11*20#");
    expect(divertInstructions(null, NUMBER).notes.join(" ")).toContain("ask your network");
  });

  it("gives the busy and unreachable codes the same way for every network", () => {
    const { codes } = divertInstructions("three", NUMBER);
    expect(codes[1]!.turnOn).toBe("**67*+441134960150#");
    expect(codes[2]!.turnOn).toBe("**62*+441134960150#");
  });

  it("knows the voicemail restore code for O2, Vodafone and EE only", () => {
    expect(divertInstructions("o2", NUMBER).restoreVoicemail).toBe("**61*901#");
    expect(divertInstructions("vodafone", NUMBER).restoreVoicemail).toBe("**61*121*11*30#");
    expect(divertInstructions("ee", NUMBER).restoreVoicemail).toBe("**61*+447953222222*11*30#");
    expect(divertInstructions("three", NUMBER).restoreVoicemail).toBeNull();
    expect(divertInstructions(null, NUMBER).restoreVoicemail).toBeNull();
  });

  it("refuses a number that isn't in +44 form", () => {
    expect(() => divertInstructions("o2", "01134960150")).toThrow("+44 form");
    expect(() => divertInstructions("o2", "+44 113 496 0150")).toThrow("+44 form");
  });
});

describe("divertInstructionsText", () => {
  it("fits the code, the check, the test and the link in one text", () => {
    const text = divertInstructionsText("o2", NUMBER, "https://app.example.com/tenants/t1/phone");
    expect(text).toBe(
      "AnswerMate: to send calls you miss to your assistant, dial **61*+441134960150*11*20# and press call. " +
        "Check it with *#61#. Then ring your mobile from another phone, don't answer, and leave a short message after the beep. " +
        "Full steps: https://app.example.com/tenants/t1/phone",
    );
    expect(divertInstructionsText("ee", NUMBER, "https://x.example/p")).toContain(
      "If it fails, the page below shows how to set it in your phone.",
    );
  });
});
