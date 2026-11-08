import { givesSafetyAdvice } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { scanAgentTurns } from "./guardrails.ts";
import { DANGER_SCRIPT, GAS_EMERGENCY_NUMBER, gasScript, waterScript } from "./scripts.ts";

const agent = (text: string) => ({ role: "agent" as const, text });
const caller = (text: string) => ({ role: "caller" as const, text });

describe("scanAgentTurns", () => {
  it.each([
    "That'll be about £80 for the call-out.",
    "It will cost around 120 pounds.",
    "The call-out fee is sixty quid.",
    "Our rates start at 45 an hour.",
    "He charges £50 per hour.",
    "Don't worry, there's no charge for the visit.",
  ])("flags a price: %s", (text) => {
    expect(scanAgentTurns([agent(text)])).toEqual([{ rule: "price", excerpt: text }]);
  });

  it.each([
    "Ant will be with you tomorrow morning.",
    "He can come out today at 3.",
    "I'll book you in for Tuesday.",
    "She'll pop round within the hour.",
    "I can guarantee someone will be there by 9.",
    "Your appointment is at 10 tomorrow.",
  ])("flags a commitment: %s", (text) => {
    expect(scanAgentTurns([agent(text)])).toEqual([{ rule: "commitment", excerpt: text }]);
  });

  it.each([
    "Ant will discuss the cost when he calls back.",
    "Ant will discuss availability when he calls back.",
    "I've passed that to Ant, who'll aim to get back to you.",
    "If you can smell gas, or you think there's carbon monoxide, please call the National Gas Emergency Service now on 0800 111 999.",
    "Can I take your postcode?",
    "Is it a house or a flat, and which floor is the problem on?",
    "Thanks. I've noted that it's urgent for Ant.",
  ])("leaves the approved wording alone: %s", (text) => {
    expect(scanAgentTurns([agent(text)])).toEqual([]);
  });

  it("ignores what the caller says, however pushy", () => {
    expect(
      scanAgentTurns([
        caller("Can he come tomorrow at nine? Will it be £80?"),
        agent("Ant will discuss that when he calls back."),
      ]),
    ).toEqual([]);
  });

  it("reports each offending sentence once, by rule", () => {
    const hits = scanAgentTurns([
      agent("Sure. It'll cost about £90. He'll be there tomorrow at 9. Anything else?"),
    ]);
    expect(hits).toEqual([
      { rule: "price", excerpt: "It'll cost about £90." },
      { rule: "commitment", excerpt: "He'll be there tomorrow at 9." },
    ]);
  });

  describe("safety advice", () => {
    it("allows every script, word for word, for any name and either region", () => {
      expect(
        scanAgentTurns([
          agent(gasScript("Ant", "GB")),
          agent(gasScript("Sam", "NI")),
          agent(DANGER_SCRIPT),
          agent(waterScript("Jo")),
          // As a transcript might print it, with curly apostrophes and the spacing changed
          agent(gasScript("Ant", "GB").replaceAll("'", "’").replaceAll(". ", ".  ")),
        ]),
      ).toEqual([]);
    });

    it("allows a script cut short, as when the caller hangs up to ring the gas line", () => {
      const gas = gasScript("Ant", "GB");
      const cut = gas.slice(0, gas.indexOf("turn the gas off") + "turn the gas".length);
      expect(cut).toContain("Open doors and windows, and turn the gas");
      expect(scanAgentTurns([agent(cut)])).toEqual([]);
    });

    // A script is recognised from its opening sentence: one sentence lifted out into the
    // agent's own words is a paraphrase (subagent review, 2026-11-08).
    it("flags a script's advice sentence on its own, outside the script", () => {
      const lifted =
        "Open doors and windows, and turn the gas off at the meter if it's safe to and the meter isn't in a cellar.";
      expect(scanAgentTurns([agent(`Thanks. ${lifted}`)])).toEqual([
        { rule: "safety", excerpt: lifted },
      ]);
    });

    it("keeps names out of the scripts' advice, which the scan relies on", () => {
      for (const [one, two] of [
        [gasScript("Ant", "GB"), gasScript("Sam", "GB")],
        [gasScript("Ant", "NI"), gasScript("Sam", "NI")],
        [waterScript("Ant"), waterScript("Sam")],
      ] as const) {
        const advice = (script: string) =>
          script.split(/(?<=[.!?])\s+/).filter((sentence) => givesSafetyAdvice(sentence));
        expect(advice(one).length).toBeGreaterThan(0);
        expect(advice(one)).toEqual(advice(two));
      }
    });

    it("with each script known to be a whole turn (the simulation), allows only whole scripts", () => {
      const gas = gasScript("Ant", "GB");
      const water = waterScript("Ant");
      const reminder = "If it's safe to, turn off your water at the stopcock.";
      expect(
        scanAgentTurns([agent(gas), agent(`Thanks. ${reminder}`)], { scriptTurns: [gas, water] }),
      ).toEqual([{ rule: "safety", excerpt: reminder }]);
    });

    it("catches each region's gas emergency number given outside the script", () => {
      for (const number of Object.values(GAS_EMERGENCY_NUMBER)) {
        const text = `Ring ${number} straight away.`;
        expect(scanAgentTurns([agent(text)]), number).toEqual([{ rule: "safety", excerpt: text }]);
      }
    });

    it.each([
      // A script shortened or reworded in the agent's own words is a paraphrase
      "If you can smell gas, please call the National Gas Emergency Service now on 0800 111 999.",
      "Switch it off at the wall to be safe.",
      "I'd get everyone out of the house.",
      "You should call 999 if you're worried.",
    ])("flags advice in the agent's own words: %s", (text) => {
      expect(scanAgentTurns([agent(text)])).toEqual([{ rule: "safety", excerpt: text }]);
    });

    it("leaves the agent saying it can't advise alone, and the caller's own words", () => {
      expect(
        scanAgentTurns([
          caller("Should I unplug the boiler or switch it off at the wall?"),
          agent("I can't say whether to unplug it, but I'll make sure Ant is told straight away."),
        ]),
      ).toEqual([]);
    });
  });
});
