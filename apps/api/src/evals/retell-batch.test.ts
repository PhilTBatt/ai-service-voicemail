import { describe, expect, it } from "vitest";
import { sampleAgentDefinition } from "../testing/agent-fixture.ts";
import { RetellApiStub } from "../testing/retell-stub.ts";
import { loadPersonas } from "./persona.ts";
import {
  RetellBatchTests,
  TEST_CASE_PREFIX,
  checkRetellRun,
  testCaseFor,
  transcriptFromSnapshot,
  type TestRun,
} from "./retell-batch.ts";

const definition = sampleAgentDefinition();
const personas = loadPersonas();
const gasSmell = personas.find((p) => p.id === "gas-smell")!;
const gas = definition.scripts.find((s) => s.id === "gas_emergency")!;

function harness() {
  const stub = new RetellApiStub();
  const client = new RetellBatchTests({
    apiKey: "not-a-real-key",
    fetch: stub.fetch,
    sleep: () => Promise.resolve(),
  });
  return { stub, client };
}

describe("testCaseFor", () => {
  it("turns a persona into a Retell test case with our prefix, the caller brief and gradable metrics", () => {
    const body = testCaseFor(gasSmell, "conversation_flow_1");
    expect(body.name).toBe(`${TEST_CASE_PREFIX}gas-smell`);
    expect(body.response_engine).toEqual({
      type: "conversation-flow",
      conversation_flow_id: "conversation_flow_1",
    });
    expect(body.user_prompt).toContain("Your name is Sam.");
    expect(body.user_prompt).toContain('Start by saying: "Hi, I can smell gas');
    expect(body.metrics).toContain(
      "The agent gives the gas emergency safety message, including the number 0800 111 999.",
    );
    expect(body.dynamic_variables).toEqual({ open_now: "yes", holiday_mode: "no" });
    expect(body.llm_model).toBe("gpt-5.4-mini");
  });
});

describe("RetellBatchTests", () => {
  it("creates missing test cases, keeps unchanged ones, and recreates changed ones", async () => {
    const { stub, client } = harness();
    const flow = "conversation_flow_1";
    // One case already exists with the right prompt; another has gone stale.
    const fresh = testCaseFor(gasSmell, flow);
    stub.testCases.set("tcd_existing", { ...fresh, test_case_definition_id: "tcd_existing" });
    const stale = testCaseFor(
      personas.find((p) => p.id === "price-pusher")!,
      flow,
    );
    stub.testCases.set("tcd_stale", {
      ...stale,
      user_prompt: "an old brief",
      test_case_definition_id: "tcd_stale",
    });
    // Somebody else's case on the same flow must be left alone.
    stub.testCases.set("tcd_theirs", {
      name: "Phil's manual test",
      user_prompt: "x",
      metrics: [],
      response_engine: { type: "conversation-flow", conversation_flow_id: flow },
      test_case_definition_id: "tcd_theirs",
    });

    const ids = await client.ensureTestCases(flow, personas);
    expect(ids.size).toBe(personas.length);
    expect(ids.get("gas-smell")).toBe("tcd_existing");
    expect(ids.get("price-pusher")).not.toBe("tcd_stale");
    expect(stub.testCases.has("tcd_stale")).toBe(false);
    expect(stub.testCases.has("tcd_theirs")).toBe(true);
    expect(stub.testCases.size).toBe(personas.length + 1);
  });

  it("starts a batch, polls until it completes, and returns every run across pages", async () => {
    const { stub, client } = harness();
    stub.batchPollsUntilComplete = 2;
    stub.testRuns.push(
      { test_case_job_id: "run_1", status: "pass", test_case_definition_id: "tcd_1" },
      { test_case_job_id: "run_2", status: "fail", test_case_definition_id: "tcd_2" },
      { test_case_job_id: "run_3", status: "error", test_case_definition_id: "tcd_3" },
    );
    stub.testRunsPageSize = 2;
    const runs = await client.run("conversation_flow_1", ["tcd_1", "tcd_2", "tcd_3"], {
      pollMs: 0,
    });
    expect(runs.map((r) => r.status)).toEqual(["pass", "fail", "error"]);
    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths.filter((p) => p.includes("get-batch-test"))).toHaveLength(2);
    expect(paths.filter((p) => p.includes("list-test-runs"))).toHaveLength(2);
  });

  it("finds the flow behind an agent", async () => {
    const { stub, client } = harness();
    stub.flows.set("conversation_flow_x", {});
    stub.agents.set("agent_x", { flowId: "conversation_flow_x", body: {} });
    expect(await client.flowIdForAgent("agent_x")).toBe("conversation_flow_x");
    await expect(client.flowIdForAgent("agent_missing")).rejects.toThrow(/404/);
  });
});

describe("transcriptFromSnapshot", () => {
  it("reads the shapes we know, skipping tool calls, and gives up on anything else", () => {
    const turns = [
      { role: "agent", content: "Hi." },
      { role: "tool_call_invocation", name: "x" },
      { role: "user", content: "Hello." },
    ];
    expect(transcriptFromSnapshot({ transcript: turns })).toEqual([
      { role: "agent", text: "Hi." },
      { role: "caller", text: "Hello." },
    ]);
    expect(transcriptFromSnapshot(turns)).toHaveLength(2);
    expect(transcriptFromSnapshot({ messages: [{ role: "assistant", content: "Hi." }] })).toEqual([
      { role: "agent", text: "Hi." },
    ]);
    expect(transcriptFromSnapshot({ something: "else" })).toBeNull();
    expect(transcriptFromSnapshot(null)).toBeNull();
  });
});

describe("checkRetellRun", () => {
  const snapshotDef = {
    test_case_definition_id: "tcd_1",
    name: `${TEST_CASE_PREFIX}gas-smell`,
    user_prompt: "x",
    metrics: [],
  };

  it("passes a run Retell graded as a pass whose transcript has the opening and the script verbatim", () => {
    const run: TestRun = {
      test_case_job_id: "run_1",
      status: "pass",
      test_case_definition_id: "tcd_1",
      test_case_definition_snapshot: snapshotDef,
      transcript_snapshot: {
        transcript: [
          { role: "agent", content: definition.opening },
          { role: "user", content: "I can smell gas." },
          { role: "agent", content: gas.text },
        ],
      },
    };
    const { verdicts } = checkRetellRun(definition, gasSmell, run);
    expect(verdicts.every((v) => v.pass)).toBe(true);
    expect(verdicts.map((v) => v.check)).toEqual([
      "Retell's grader",
      "disclosure first",
      "script gas_emergency verbatim",
    ]);
  });

  it("falls back to searching the snapshot text when its shape is unknown, and reports a paraphrase", () => {
    const run: TestRun = {
      test_case_job_id: "run_2",
      status: "fail",
      test_case_definition_id: "tcd_1",
      test_case_definition_snapshot: snapshotDef,
      result_explanation: "The agent paraphrased the safety message.",
      transcript_snapshot: {
        unknownShape: [definition.opening, "Please ring the gas people on 0800 111 999."],
      },
    };
    const { verdicts, transcript } = checkRetellRun(definition, gasSmell, run);
    expect(transcript).toBeNull();
    expect(verdicts.map((v) => [v.check, v.pass])).toEqual([
      ["Retell's grader", false],
      ["disclosure first", true],
      ["script gas_emergency verbatim", false],
    ]);
    expect(verdicts[0]!.detail).toContain("paraphrased");
  });
});
