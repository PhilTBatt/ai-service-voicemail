import { describe, expect, it } from "vitest";
import { scanAgentTurns } from "./guardrails.ts";

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
    "If you can smell gas, please call the National Gas Emergency Service now on 0800 111 999.",
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
});
