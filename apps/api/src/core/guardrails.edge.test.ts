// How the post-call scan and the spoken-script checks read a real transcript: Appendix A's
// scripts spoken word for word must never be flagged, whatever the names or the typography the
// speech platform used, and anything the agent adds of its own must be.
import { givesSafetyAdvice } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { scanAgentTurns } from "./guardrails.ts";
import {
  dangerScriptSpoken,
  emergencyScriptSpoken,
  gasScriptSpoken,
  waterScriptSpoken,
} from "./spoken-scripts.ts";
import {
  DANGER_SCRIPT,
  GAS_EMERGENCY_NUMBER,
  areYouAiLine,
  closingLine,
  gasScript,
  openingLine,
  waterScript,
} from "./scripts.ts";

const agent = (text: string) => ({ role: "agent" as const, text });
const caller = (text: string) => ({ role: "caller" as const, text });

// Names a tradesperson might really have, including ones that look like the words the
// patterns look for ("Will", "Sunday", "Tuesday", "Grant", "Price").
const NAMES = ["Ant", "Will", "Sunday", "Tuesday", "Grant", "Price", "O'Brien", "Anne-Marie"];
const BUSINESSES = ["Ant's Plumbing", "Today Heating", "24 Hour Gas Ltd", "Price & Sons"];

function everyScript(name: string, business: string): [string, string][] {
  return [
    ...Object.keys(GAS_EMERGENCY_NUMBER).map(
      (region) =>
        [`gas (${region})`, gasScript(name, region as keyof typeof GAS_EMERGENCY_NUMBER)] as [
          string,
          string,
        ],
    ),
    ["danger", DANGER_SCRIPT],
    ["water", waterScript(name)],
    ["opening", openingLine({ business, tradesperson: name })],
    ["are you an AI", areYouAiLine({ business, tradesperson: name })],
    ["closing", closingLine(name)],
  ];
}

describe("scanAgentTurns on the approved scripts", () => {
  it("never flags a script spoken word for word, for any name or business", () => {
    for (const name of NAMES) {
      for (const business of BUSINESSES) {
        for (const [which, script] of everyScript(name, business)) {
          expect(scanAgentTurns([agent(script)]), `${which}, ${name}, ${business}`).toEqual([]);
        }
      }
    }
  });

  it("recognises a script with curly apostrophes, doubled spaces and a line break in it", () => {
    for (const region of Object.keys(
      GAS_EMERGENCY_NUMBER,
    ) as (keyof typeof GAS_EMERGENCY_NUMBER)[]) {
      const typeset = gasScript("Ant", region)
        .replaceAll("'", "’")
        .replaceAll(". ", ".  ")
        .replace("Don't smoke,", "Don’t smoke,\n");
      expect(scanAgentTurns([agent(typeset)]), region).toEqual([]);
    }
  });

  it("recognises a script that starts part-way through a turn", () => {
    const text = `Okay, thanks for telling me. ${gasScript("Ant", "GB")}`;
    expect(scanAgentTurns([agent(text)])).toEqual([]);
  });

  it("flags the agent's own advice tacked on after a script", () => {
    const extra = "Also, open all the windows.";
    expect(scanAgentTurns([agent(`${DANGER_SCRIPT} ${extra}`)])).toEqual([
      { rule: "safety", excerpt: extra },
    ]);
  });

  it("flags a script's sentences said in the wrong order: that's the agent's own words", () => {
    const sentences = gasScript("Ant", "GB").split(/(?<=[.!?])\s+/);
    const shuffled = [sentences[2], sentences[0]].join(" ");
    expect(scanAgentTurns([agent(shuffled)]).map((hit) => hit.rule)).toContain("safety");
  });

  it("never flags the caller, even reading a script back or quoting a price", () => {
    expect(
      scanAgentTurns([
        caller(gasScript("Ant", "GB")),
        caller("Last time it was £80 and he came within the hour. Turn the gas off, yeah?"),
      ]),
    ).toEqual([]);
  });
});

describe("the doors-and-windows advice, however it's worded", () => {
  // The gas script's own advice ("Open doors and windows") in the agent's words. "All the" and
  // "all of the" used to slip through: only one word was allowed before "windows".
  it.each([
    "Open the windows.",
    "Open all windows.",
    "Open all the windows.",
    "Please open all the doors and windows.",
    "Open some of the windows.",
    "Leave all the windows open.",
    "Keep all of the doors open.",
    "Keep your windows and doors open.",
  ])("flags %j", (text) => {
    expect(givesSafetyAdvice(text)).toBe(true);
  });

  it.each([
    "We open all the windows when we work.",
    "He'll open all the doors when he gets there.",
    "Were you able to open all the windows?",
    "I can't advise you to open all the windows.",
  ])("leaves %j alone", (text) => {
    expect(givesSafetyAdvice(text)).toBe(false);
  });
});

describe("scanAgentTurns on awkward turns", () => {
  it.each(["", " ", "\n", "...", "Mm.", "\u{1F44D}"])("finds nothing in %j", (text) => {
    expect(scanAgentTurns([agent(text)])).toEqual([]);
  });

  it("finds nothing in an empty transcript", () => {
    expect(scanAgentTurns([])).toEqual([]);
  });

  it("keeps each excerpt to 160 characters for the review queue", () => {
    const long = `It'll cost about £80 ${"and that includes everything you could think of ".repeat(10)}.`;
    const [hit] = scanAgentTurns([agent(long)]);
    expect(hit?.rule).toBe("price");
    expect(hit!.excerpt.length).toBe(160);
    expect(long.startsWith(hit!.excerpt)).toBe(true);
  });

  it("reads a curly apostrophe as a straight one, so 'it’ll cost' is still a price", () => {
    expect(scanAgentTurns([agent("It’ll cost about £80.")])).toEqual([
      { rule: "price", excerpt: "It’ll cost about £80." },
    ]);
  });

  it("records a sentence that breaks two rules under both", () => {
    const text = "He'll be there tomorrow at 9 and it'll cost about £60.";
    expect(
      scanAgentTurns([agent(text)])
        .map((hit) => hit.rule)
        .sort(),
    ).toEqual(["commitment", "price"]);
  });

  it("scans every agent turn, not just the first", () => {
    const hits = scanAgentTurns([
      agent("Hi, how can I help?"),
      caller("Leak."),
      agent("Thanks."),
      caller("And?"),
      agent("He'll be there tomorrow at 9."),
    ]);
    expect(hits).toEqual([{ rule: "commitment", excerpt: "He'll be there tomorrow at 9." }]);
  });
});

describe("the spoken-script checks on stored transcripts", () => {
  const stored = (...lines: string[]) => lines.join("\n");

  it.each([
    [
      "the gas script",
      stored(`agent: ${gasScript("Ant", "NI")}`),
      { gas: true, danger: false, water: false },
    ],
    [
      "the danger script",
      stored(`agent: ${DANGER_SCRIPT}`),
      { gas: false, danger: true, water: false },
    ],
    [
      "the water script",
      stored(`agent: ${waterScript("Ant")}`),
      { gas: false, danger: false, water: true },
    ],
    [
      "a script in capitals on an 'Agent:' line",
      stored(`Agent: ${DANGER_SCRIPT.toUpperCase()}`),
      { gas: false, danger: true, water: false },
    ],
    [
      "a line ending in a carriage return",
      stored(`agent: ${DANGER_SCRIPT}\r`, "caller: ok\r"),
      { gas: false, danger: true, water: false },
    ],
    [
      "the caller saying the script",
      stored(`caller: ${gasScript("Ant", "GB")} ${DANGER_SCRIPT} ${waterScript("Ant")}`),
      { gas: false, danger: false, water: false },
    ],
    [
      "a caller line that pretends to be the agent",
      stored(`caller: agent: ${DANGER_SCRIPT}`),
      { gas: false, danger: false, water: false },
    ],
    ["a line with no speaker", stored(DANGER_SCRIPT), { gas: false, danger: false, water: false }],
    ["an empty transcript", "", { gas: false, danger: false, water: false }],
  ])("reads %s", (_what, transcript, want) => {
    expect({
      gas: gasScriptSpoken(transcript),
      danger: dangerScriptSpoken(transcript),
      water: waterScriptSpoken(transcript),
    }).toEqual(want);
    expect(emergencyScriptSpoken(transcript)).toBe(want.gas || want.danger);
  });

  it("treats a cleared transcript (null) as no script", () => {
    expect(emergencyScriptSpoken(null)).toBe(false);
    expect(waterScriptSpoken(null)).toBe(false);
  });

  it("finds the danger script in a turn cut off just after its key words", () => {
    expect(
      dangerScriptSpoken(
        "agent: If anyone is in danger, or there's a fire or smoke, please hang up now and call 999",
      ),
    ).toBe(true);
  });
});
