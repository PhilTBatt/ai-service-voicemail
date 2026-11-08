// Runs the eval personas as Retell batch tests against a synced agent's real conversation
// flow: Retell's AI plays each caller, Retell grades the run, and our verbatim checks have the
// final say. Spends Retell credit (chat rates, a few pence per persona). Needs RETELL_API_KEY.
// Run from the repo root:
//   npm run live-evals-retell -- --agent <retell agent id> [--persona gas-smell ...]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { DEMO_TRADE, evalAgents } from "../evals/businesses.ts";
import { loadPersonas, PERSONAS_DIR } from "../evals/persona.ts";
import { RetellBatchTests, TEST_CASE_PREFIX, checkRetellRun } from "../evals/retell-batch.ts";

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    persona: { type: "string", multiple: true },
    out: { type: "string", default: path.resolve(PERSONAS_DIR, "../reports") },
  },
});

const config = loadConfig(process.env);
if (!config.retellApiKey) {
  console.error("RETELL_API_KEY is missing.");
  process.exit(2);
}
if (!values.agent) {
  console.error("--agent <retell agent id> is required (the synced demo agent's ID).");
  process.exit(2);
}

// The synced demo agent is the plumber: personas that ring another trade's business can only
// run in the local simulation (npm run evals).
const all = loadPersonas();
const otherTrades = all.filter((p) => p.trade !== DEMO_TRADE).map((p) => p.id);
const demoPersonas = all.filter((p) => p.trade === DEMO_TRADE);
const selected = values.persona?.length
  ? demoPersonas.filter((p) => values.persona!.includes(p.id))
  : demoPersonas;
if (selected.length === 0) {
  console.error(
    `No demo-trade personas matched. Known: ${demoPersonas.map((p) => p.id).join(", ")}`,
  );
  process.exit(2);
}
if (otherTrades.length > 0) {
  console.log(`Left out (another trade's business, local evals only): ${otherTrades.join(", ")}`);
}
const { definition } = evalAgents()({ trade: DEMO_TRADE });
const client = new RetellBatchTests({ apiKey: config.retellApiKey });

const flowId = await client.flowIdForAgent(values.agent);
console.log(`Agent ${values.agent} uses flow ${flowId}. Syncing ${selected.length} test cases...`);
const ids = await client.ensureTestCases(flowId, selected);
console.log("Starting the batch (this takes a few minutes)...");
const runs = await client.run(flowId, [...ids.values()]);

const lines = [`# Retell batch evals: ${new Date().toISOString()}`, "", `Flow: ${flowId}`, ""];
let failed = 0;
for (const persona of selected) {
  const run = runs.find(
    (r) => r.test_case_definition_snapshot.name === `${TEST_CASE_PREFIX}${persona.id}`,
  );
  if (!run) {
    lines.push(`## ${persona.name}: NO RUN`, "");
    failed += 1;
    continue;
  }
  const { verdicts, transcript } = checkRetellRun(definition, persona, run);
  const passed = verdicts.every((v) => v.pass);
  if (!passed) failed += 1;
  lines.push(`## ${persona.name} (${persona.id}): ${passed ? "pass" : "FAIL"}`, "");
  for (const v of verdicts)
    lines.push(`- ${v.pass ? "✅" : "❌"} ${v.check}${v.detail ? `: ${v.detail}` : ""}`);
  lines.push("");
  if (transcript) {
    for (const turn of transcript) {
      lines.push(
        `> **${turn.role === "agent" ? "Assistant" : "Caller"}:** ${turn.text || "[silence]"}`,
      );
    }
  } else {
    lines.push(
      "```json",
      JSON.stringify(run.transcript_snapshot ?? null, null, 2).slice(0, 4000),
      "```",
    );
  }
  lines.push("");
}

mkdirSync(values.out, { recursive: true });
const file = path.join(
  values.out,
  `retell-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.md`,
);
writeFileSync(file, lines.join("\n"));
console.log(`${selected.length - failed} passed, ${failed} failed. Report: ${file}`);
process.exitCode = failed === 0 ? 0 : 1;
