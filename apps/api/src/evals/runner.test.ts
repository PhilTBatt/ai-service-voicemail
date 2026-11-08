import { describe, expect, it } from "vitest";
import { URGENCY_RULES } from "../core/extraction.ts";
import { FakeLlmProvider } from "../providers/llm.fake.ts";
import { sampleAgentDefinition } from "../testing/agent-fixture.ts";
import { evalAgents } from "./businesses.ts";
import { buildJudgePrompt } from "./judge.ts";
import { parsePersona } from "./persona.ts";
import { renderProgress, renderReport } from "./report.ts";
import { runEvals, type EvalProgress } from "./runner.ts";

const definition = sampleAgentDefinition();
const context = { businessName: "Ant's Plumbing", tradespersonName: "Ant" };

const tap = parsePersona(
  `
id: tap
name: Dripping tap
description: x
caller:
  brief: Dripping tap.
  name: Sam
  phone: "07700 900123"
  postcode: XQ12 3JL
  opening: "My tap is dripping."
expect:
  urgency: routine
  fields:
    callerName: Sam
  ending: close
`,
  "tap.yaml",
);
const silent = parsePersona(
  `id: silent\nname: Silent\ndescription: x\ncaller:\n  brief: Silence.\n  silent: true\nexpect:\n  ending: silence\n  maxTurns: 6\n`,
  "silent.yaml",
);

const EXTRACTION = {
  callerName: "Sam",
  callbackNumber: "+447700900123",
  postcode: "XQ12 3JL",
  jobSummary: "Dripping kitchen tap.",
  urgency: "routine",
  priceAsked: false,
  flags: [],
};

describe("runEvals", () => {
  it("simulates, extracts with the real prompt, judges, and reports per persona", async () => {
    const llm = new FakeLlmProvider()
      // tap: agent turn, caller turn, agent done; then extraction; then judge
      .willReturn({ trigger: "none", reply: "Can I take your name?", done: false })
      .willReturn({ say: "Sam, 07700 900123, XQ12 3JL.", hangUp: false })
      .willReturn({ trigger: "none", reply: "Thanks.", done: true })
      .willReturn(EXTRACTION)
      .willReturn({ pass: true, reason: "supported" })
      // silent: one agent prompt; extraction; judge
      .willReturn({ trigger: "none", reply: "Are you still there?", done: false })
      .willReturn({
        ...EXTRACTION,
        callerName: null,
        callbackNumber: null,
        postcode: null,
        urgency: "other",
        jobSummary: "Caller said nothing.",
      })
      .willReturn({ pass: true, reason: "nothing to contradict" });

    const report = await runEvals({
      agentFor: () => ({ definition, context }),
      personas: [tap, silent],
      llm,
      capPence: 100,
      now: () => new Date("2026-11-07T22:00:00Z"),
    });

    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.abortedByCostCap).toBe(false);
    expect(report.cost).toEqual({
      estimatedPence: 0,
      capPence: 100,
      inputTokens: 800,
      outputTokens: 160,
      calls: 8,
    });
    // The extraction request is the pipeline's own prompt, over the simulated transcript.
    const extractionRequest = llm.requests[3]!;
    expect(extractionRequest.system).toContain("extract what Ant needs");
    expect(extractionRequest.user).toContain("Caller: Sam, 07700 900123, XQ12 3JL.");
    // And the judge saw the summary.
    expect(llm.requests[4]!.user).toContain("Summary: Dripping kitchen tap.");

    const markdown = renderReport(report);
    expect(markdown).toContain("# Eval run: PASS");
    expect(markdown).toContain("| Dripping tap | pass |");
    expect(markdown).toContain("**Caller:** [silence]");
  });

  it("marks a persona failed when a check fails, and the run as FAIL", async () => {
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "none", reply: "It'll be about £90.", done: true })
      .willReturn({ ...EXTRACTION, urgency: "urgent" })
      .willReturn({
        pass: false,
        reason: "The summary says kitchen; the caller never said which tap.",
      });
    const report = await runEvals({
      agentFor: () => ({ definition, context }),
      personas: [tap],
      llm,
      capPence: 100,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0]!.verdicts.filter((v) => !v.pass).map((v) => v.check)).toEqual([
      "no prices",
      "urgency",
      "summary matches transcript (judge)",
    ]);
    expect(renderReport(report)).toContain("# Eval run: FAIL (1 of 1)");
  });

  it("stops at the cost cap, records the abort and skips the rest", async () => {
    const llm = new FakeLlmProvider().willReturn({ trigger: "none", reply: "Hi.", done: false });
    // A real model's prices with a 0p cap: the first call tips it over.
    const pricey = Object.assign(llm, { model: "claude-sonnet-5-5" });
    const report = await runEvals({
      agentFor: () => ({ definition, context }),
      personas: [tap, silent],
      llm: pricey,
      capPence: 0,
    });
    expect(report.abortedByCostCap).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.error).toMatch(/passed the cap/);
    expect(report.skipped).toEqual(["silent"]);
    expect(renderReport(report)).toContain("ABORTED: cost cap");
  });

  it("records a model error against the persona and carries on with the next", async () => {
    const llm = new FakeLlmProvider()
      .willThrow("rate limited")
      .willReturn({ trigger: "none", reply: "Still there?", done: false })
      .willReturn({
        ...EXTRACTION,
        callerName: null,
        callbackNumber: null,
        postcode: null,
        urgency: "other",
      })
      .willReturn({ pass: true, reason: "ok" });
    const report = await runEvals({
      agentFor: () => ({ definition, context }),
      personas: [tap, silent],
      llm,
      capPence: 100,
    });
    expect(report.results.map((r) => [r.id, r.passed, r.error])).toEqual([
      ["tap", false, "rate limited"],
      ["silent", true, undefined],
    ]);
  });

  it("can run without the judge", async () => {
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "none", reply: "Thanks.", done: true })
      .willReturn(EXTRACTION);
    const report = await runEvals({
      agentFor: () => ({ definition, context }),
      personas: [tap],
      llm,
      capPence: 100,
      judge: false,
    });
    expect(report.results[0]!.judge).toBeNull();
    expect(report.results[0]!.verdicts.map((v) => v.check)).not.toContain(
      "summary matches transcript (judge)",
    );
  });
});

describe("buildJudgePrompt", () => {
  it("shows the judge the transcript and everything that was extracted", () => {
    const { system, user } = buildJudgePrompt(
      [
        { role: "agent", text: "Hi." },
        { role: "caller", text: "" },
      ],
      { ...EXTRACTION, urgency: "routine" },
    );
    expect(system).toContain("hallucination");
    expect(user).toContain("Caller: [silence]");
    expect(user).toContain("Name: Sam");
    expect(user).toContain("Flags: none");
  });

  // The eval run of 2026-11-07 failed a calmly mentioned gas smell's "emergency" as unsupported.
  it("judges the urgency by the extraction's own rules, not by how worried the caller sounded", () => {
    const { system } = buildJudgePrompt([], { ...EXTRACTION, urgency: "emergency" });
    expect(system).toContain(URGENCY_RULES);
    expect(system).toContain("not by how worried the caller sounded");
  });
});

describe("progress while a run is going", () => {
  // A full run printed nothing for about seven minutes, and looked stuck (2026-11-08).
  it("reports each persona as it finishes, with the cost so far", async () => {
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "none", reply: "Thanks.", done: true })
      .willReturn(EXTRACTION)
      // The silent persona's first model call fails.
      .willThrow("rate limited");
    const seen: EvalProgress[] = [];
    await runEvals({
      agentFor: () => ({ definition, context }),
      personas: [tap, silent],
      llm,
      capPence: 100,
      judge: false,
      onResult: (progress) => seen.push(progress),
    });
    expect(seen.map((p) => [p.result.id, p.done, p.total])).toEqual([
      ["tap", 1, 2],
      ["silent", 2, 2],
    ]);
    expect(renderProgress(seen[0]!)).toBe("[1/2] pass  Dripping tap (0p so far)");
    expect(renderProgress(seen[1]!)).toBe("[2/2] ERROR Silent: rate limited (0p so far)");
  });

  it("names the failed checks, and lines the counter up", () => {
    const line = renderProgress({
      result: {
        id: "x",
        name: "Price-pusher",
        passed: false,
        verdicts: [
          { check: "no prices", pass: false },
          { check: "urgency", pass: true },
          { check: "field postcode", pass: false },
        ],
        simulation: null,
        extraction: null,
        judge: null,
      },
      done: 3,
      total: 24,
      spentPence: 2,
    });
    expect(line).toBe("[ 3/24] FAIL  Price-pusher: no prices, field postcode (2p so far)");
  });
});

describe("runEvals with several trades", () => {
  it("puts each persona through the agent for its own trade", async () => {
    const roofing = { ...tap, id: "roof", trade: "roofer" as const };
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "none", reply: "Thanks.", done: true })
      .willReturn(EXTRACTION);
    const agentFor = evalAgents();
    await runEvals({ agentFor, personas: [roofing], llm, capPence: 100, judge: false });
    // The agent model was given the roofer's prompt, and the extraction the roofer's name.
    expect(llm.requests[0]!.system).toContain("You are the AI phone assistant for Test Roofing");
    expect(llm.requests[1]!.system).toContain("on behalf of Test Roofing");
  });
});
