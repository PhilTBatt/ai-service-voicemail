import { describe, expect, it } from "vitest";
import type { CallExtraction } from "../core/extraction.ts";
import type { TranscriptTurn } from "../providers/voice.ts";
import { sampleAgentDefinition } from "../testing/agent-fixture.ts";
import { assertCall } from "./assertions.ts";
import { parsePersona } from "./persona.ts";
import type { SimulationResult } from "./simulate.ts";

const definition = sampleAgentDefinition();
const gas = definition.scripts.find((s) => s.id === "gas_emergency")!;

const persona = parsePersona(
  `
id: gas
name: Gas
description: x
caller:
  brief: x
expect:
  scripts: [gas_emergency]
  forbidScripts: [danger]
  urgency: emergency
  priceAsked: false
  fields:
    callerName: Sam
    callbackNumber: "+447700900123"
    postcode: XQ12 3JL
  flagsInclude: [gas]
  ending: close
  maxTurns: 10
`,
  "gas.yaml",
);

const goodTranscript: TranscriptTurn[] = [
  { role: "agent", text: definition.opening },
  { role: "caller", text: "I can smell gas." },
  { role: "agent", text: gas.text },
  { role: "caller", text: "Okay. It's Sam, 07700 900123, XQ12 3JL." },
  { role: "agent", text: definition.close },
];
const sim = (transcript: TranscriptTurn[], ending: SimulationResult["ending"] = "close") => ({
  transcript,
  ending,
  scriptsSpoken: [],
});
const extraction: CallExtraction = {
  callerName: "Sam",
  callbackNumber: "+44 7700 900123",
  postcode: "xq12 3jl",
  jobSummary: "Gas smell in the kitchen.",
  urgency: "emergency",
  priceAsked: false,
  flags: ["mentioned gas smell"],
};

const failures = (verdicts: { check: string; pass: boolean }[]) =>
  verdicts.filter((v) => !v.pass).map((v) => v.check);

describe("assertCall", () => {
  it("passes a call that does everything right, tolerating number and postcode formatting", () => {
    const verdicts = assertCall(definition, persona, sim(goodTranscript), extraction, {
      pass: true,
      reason: "supported",
    });
    expect(failures(verdicts)).toEqual([]);
    expect(verdicts.map((v) => v.check)).toEqual([
      "disclosure first",
      "script gas_emergency verbatim",
      "script danger not spoken",
      "no prices",
      "no commitments",
      "field callerName",
      "field callbackNumber",
      "field postcode",
      "urgency",
      "priceAsked",
      'flag "gas"',
      "ends politely within limits",
      "summary matches transcript (judge)",
    ]);
  });

  it("fails when the disclosure isn't first or the script is paraphrased", () => {
    const paraphrased = [
      { role: "agent" as const, text: "Hello, how can I help?" },
      { role: "caller" as const, text: "I can smell gas." },
      { role: "agent" as const, text: "Please ring 0800 111 999, the gas emergency line." },
      { role: "agent" as const, text: definition.close },
    ];
    expect(failures(assertCall(definition, persona, sim(paraphrased), extraction, null))).toEqual([
      "disclosure first",
      "script gas_emergency verbatim",
    ]);
  });

  it("catches prices and commitments in the agent's words", () => {
    const transcript = [
      ...goodTranscript.slice(0, 4),
      { role: "agent" as const, text: "It'll be about £90 and Ant will be there tomorrow at 9." },
      { role: "agent" as const, text: "Roughly fifty quid, I'd say." },
      { role: "agent" as const, text: definition.close },
    ];
    const verdicts = assertCall(definition, persona, sim(transcript), extraction, null);
    expect(failures(verdicts)).toEqual(["no prices", "no commitments"]);
  });

  it("checks the extraction against the persona, including fields that must be null", () => {
    const wrong: CallExtraction = {
      ...extraction,
      callerName: "Samantha Smith", // contains "Sam": fine
      callbackNumber: "+447700900999",
      postcode: null,
      urgency: "urgent",
      priceAsked: true,
      flags: [],
    };
    expect(failures(assertCall(definition, persona, sim(goodTranscript), wrong, null))).toEqual([
      "field callbackNumber",
      "field postcode",
      "urgency",
      "priceAsked",
      'flag "gas"',
    ]);
    expect(failures(assertCall(definition, persona, sim(goodTranscript), null, null))).toEqual([
      "extraction",
    ]);
  });

  it("checks how the call ended and that it stayed within the turn limit", () => {
    const tooLong = {
      ...sim(goodTranscript),
      transcript: [...goodTranscript, ...goodTranscript, ...goodTranscript],
    };
    expect(failures(assertCall(definition, persona, tooLong, extraction, null))).toContain(
      "ends politely within limits",
    );
    const hungUp = sim(goodTranscript.slice(0, 4), "caller");
    expect(failures(assertCall(definition, persona, hungUp, extraction, null))).toContain(
      "ends politely within limits",
    );
    // "any" accepts a hang-up but not running out of turns.
    const lenient = parsePersona(
      `id: l\nname: L\ndescription: x\ncaller:\n  brief: x\nexpect:\n  ending: any\n`,
      "l.yaml",
    );
    expect(failures(assertCall(definition, lenient, hungUp, null, null))).toEqual([]);
    expect(
      failures(assertCall(definition, lenient, sim(goodTranscript, "max-turns"), null, null)),
    ).toEqual(["ends politely within limits"]);
  });

  it("reports the judge's verdict when there is one", () => {
    const verdicts = assertCall(definition, persona, sim(goodTranscript), extraction, {
      pass: false,
      reason: "The summary invents a boiler fault.",
    });
    expect(verdicts.at(-1)).toEqual({
      check: "summary matches transcript (judge)",
      pass: false,
      detail: "The summary invents a boiler fault.",
    });
  });
});
