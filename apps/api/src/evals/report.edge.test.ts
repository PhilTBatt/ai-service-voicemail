// The eval report and the judge, offline (FakeLlmProvider: no model is ever called): a judge
// that gives no usable verdict fails the persona rather than passing it, its cost counts
// towards the cap, and the Markdown report shows what a reader needs for each outcome.
import { describe, expect, it } from "vitest";
import type { CallExtraction } from "../core/extraction.ts";
import { FakeLlmProvider } from "../providers/llm.fake.ts";
import { CostCapExceededError, CostMeter } from "./cost.ts";
import { judgeSchema, judgeSummary } from "./judge.ts";
import { renderProgress, renderReport } from "./report.ts";
import type { EvalReport, PersonaResult } from "./runner.ts";

const EXTRACTION: CallExtraction = {
  callerName: "Sam",
  callbackNumber: "+447700900123",
  postcode: "XQ12 3JL",
  jobSummary: "Dripping kitchen tap.",
  urgency: "routine",
  priceAsked: false,
  flags: [],
};
const TRANSCRIPT = [
  { role: "agent" as const, text: "Hello." },
  { role: "caller" as const, text: "My tap drips." },
];

describe("judgeSummary", () => {
  it("passes on the judge's word, with the usage of its call", async () => {
    const llm = new FakeLlmProvider().willReturn({ pass: true, reason: "supported" });
    const verdict = await judgeSummary(llm, null, TRANSCRIPT, EXTRACTION);
    expect(verdict).toEqual({
      pass: true,
      reason: "supported",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  // A judge that can't give a verdict hasn't checked anything: counting that as a pass would
  // let a hallucinated summary through unseen.
  it.each(["invalid-output", "refused"] as const)(
    "fails the summary when the judge's answer is %s",
    async (reason) => {
      const llm = new FakeLlmProvider().willFail(reason);
      const verdict = await judgeSummary(llm, null, TRANSCRIPT, EXTRACTION);
      expect(verdict.pass).toBe(false);
      expect(verdict.reason).toBe(`Judge gave no usable verdict (${reason})`);
    },
  );

  it("fails the summary when the judge's reason is empty or runs past the limit", async () => {
    for (const reason of ["", "x".repeat(1501)]) {
      const llm = new FakeLlmProvider().willReturn({ pass: true, reason });
      expect((await judgeSummary(llm, null, TRANSCRIPT, EXTRACTION)).pass).toBe(false);
    }
  });

  it("adds its call to the meter, so the cap counts the judge too", async () => {
    const llm = Object.assign(new FakeLlmProvider().willReturn({ pass: true, reason: "ok" }), {
      model: "claude-haiku-5-5",
    });
    const meter = new CostMeter({ model: llm.model, capPence: 100 });
    await judgeSummary(llm, meter, TRANSCRIPT, EXTRACTION);
    expect(meter.calls).toBe(1);
    expect(meter.inputTokens).toBe(100);
  });

  it("throws the cap's error once the judge's call passes it", async () => {
    const llm = Object.assign(new FakeLlmProvider().willReturn({ pass: true, reason: "ok" }), {
      model: "claude-sonnet-5-5",
    });
    const meter = new CostMeter({ model: llm.model, capPence: 0 });
    await expect(judgeSummary(llm, meter, TRANSCRIPT, EXTRACTION)).rejects.toThrow(
      CostCapExceededError,
    );
  });

  it("lets a model error through to the runner, which records it against the persona", async () => {
    const llm = new FakeLlmProvider().willThrow("overloaded", 529);
    await expect(judgeSummary(llm, null, TRANSCRIPT, EXTRACTION)).rejects.toThrow("overloaded");
  });

  it("asks for a verdict the schema can check", () => {
    expect(judgeSchema.safeParse({ pass: "yes", reason: "x" }).success).toBe(false);
    expect(judgeSchema.safeParse({ pass: false }).success).toBe(false);
  });
});

function result(overrides: Partial<PersonaResult>): PersonaResult {
  return {
    id: "tap",
    name: "Dripping tap",
    passed: true,
    verdicts: [],
    simulation: null,
    extraction: null,
    judge: null,
    ...overrides,
  };
}

function report(results: PersonaResult[], overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    startedAt: "2026-11-11T10:00:00.000Z",
    finishedAt: "2026-11-11T10:05:00.000Z",
    model: "fake-model",
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    skipped: [],
    cost: { estimatedPence: 3, capPence: 50, inputTokens: 1000, outputTokens: 200, calls: 4 },
    abortedByCostCap: false,
    ...overrides,
  };
}

describe("renderReport", () => {
  it("says PASS for an empty run, with the cost line and an empty table", () => {
    const markdown = renderReport(report([]));
    expect(markdown).toContain("# Eval run: PASS");
    expect(markdown).toContain(
      "- Cost: about 3p of a 50p cap (4 model calls, 1000 in / 200 out tokens)",
    );
    expect(markdown).toContain("- Passed 0, failed 0, skipped 0");
  });

  it("puts ABORTED ahead of FAIL, and lists the personas the cap skipped", () => {
    const markdown = renderReport(
      report([result({ passed: false, error: "Eval run stopped: estimated cost 51p" })], {
        abortedByCostCap: true,
        skipped: ["gas-smell", "co-alarm"],
      }),
    );
    expect(markdown).toContain("# Eval run: ABORTED: cost cap");
    expect(markdown).toContain("| gas-smell | skipped | cost cap |");
    expect(markdown).toContain("| co-alarm | skipped | cost cap |");
    expect(markdown).toContain(
      "| Dripping tap | FAIL | error: Eval run stopped: estimated cost 51p |",
    );
    expect(markdown).toContain("Error: Eval run stopped: estimated cost 51p");
  });

  it("gives a failed check's detail, and leaves a passed check's out", () => {
    const markdown = renderReport(
      report([
        result({
          passed: false,
          verdicts: [
            { check: "no prices", pass: false, detail: "said £90" },
            { check: "urgency", pass: true, detail: "routine as expected" },
          ],
        }),
      ]),
    );
    expect(markdown).toContain("# Eval run: FAIL (1 of 1)");
    expect(markdown).toContain("- ❌ no prices: said £90");
    expect(markdown).toContain("- ✅ urgency\n");
    expect(markdown).not.toContain("routine as expected");
  });

  it("shows the extraction as JSON and the transcript by speaker, silence named", () => {
    const markdown = renderReport(
      report([
        result({
          extraction: EXTRACTION,
          simulation: {
            transcript: [
              { role: "agent", text: "Hello." },
              { role: "caller", text: "" },
            ],
            ending: "silence",
            scriptsSpoken: [],
          },
        }),
      ]),
    );
    expect(markdown).toContain('"jobSummary": "Dripping kitchen tap."');
    expect(markdown).toContain("Transcript (ended: silence):");
    expect(markdown).toContain("> **Assistant:** Hello.");
    expect(markdown).toContain("> **Caller:** [silence]");
  });
});

describe("renderProgress", () => {
  it("lines the counter up for a hundred personas or more", () => {
    const line = renderProgress({ result: result({}), done: 7, total: 120, spentPence: 0 });
    expect(line).toBe("[  7/120] pass  Dripping tap (0p so far)");
  });

  it("names an error over any failed checks", () => {
    const line = renderProgress({
      result: result({
        passed: false,
        error: "rate limited",
        verdicts: [{ check: "urgency", pass: false }],
      }),
      done: 1,
      total: 1,
      spentPence: 5,
    });
    expect(line).toBe("[1/1] ERROR Dripping tap: rate limited (5p so far)");
  });
});
