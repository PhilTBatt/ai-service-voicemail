// Runs the eval personas against the current prompt with the real model, under a cost cap.
// Run from the repo root: npm run evals [-- --persona gas-smell --cap-pence 50 --no-judge]
// Spends Anthropic credit (a few pence per run at the default cap); needs ANTHROPIC_API_KEY.
// A full run takes several minutes; a line prints as each persona finishes.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { evalAgents } from "../evals/businesses.ts";
import { loadPersonas, PERSONAS_DIR } from "../evals/persona.ts";
import { renderProgress, renderReport } from "../evals/report.ts";
import { runEvals } from "../evals/runner.ts";
import { AnthropicLlmProvider } from "../providers/anthropic.ts";

const { values } = parseArgs({
  options: {
    persona: { type: "string", multiple: true },
    "cap-pence": { type: "string", default: "50" },
    "no-judge": { type: "boolean", default: false },
    out: { type: "string", default: path.resolve(PERSONAS_DIR, "../reports") },
  },
});

const config = loadConfig(process.env);
if (!config.llm) {
  console.error("ANTHROPIC_API_KEY is missing: the evals need a model.");
  process.exit(2);
}
const capPence = Number(values["cap-pence"]);
if (!Number.isInteger(capPence) || capPence <= 0) {
  console.error("--cap-pence must be a whole number of pence");
  process.exit(2);
}

const all = loadPersonas();
const selected = values.persona?.length ? all.filter((p) => values.persona!.includes(p.id)) : all;
if (selected.length === 0) {
  console.error(`No personas matched. Known: ${all.map((p) => p.id).join(", ")}`);
  process.exit(2);
}

const llm = new AnthropicLlmProvider(config.llm);
// A full run takes several minutes: say so, then a line as each persona finishes.
console.log(
  `Running ${selected.length} persona${selected.length === 1 ? "" : "s"} with ${llm.model}, stopping if the cost passes ${capPence}p. Each takes about 20 seconds; results print as they finish.\n`,
);

// Each persona rings a fictional business of its trade; the plumber is the demo tenant's profile,
// the one Phil's test calls use (evals/businesses.ts).
const report = await runEvals({
  agentFor: evalAgents(),
  personas: selected,
  llm,
  capPence,
  judge: !values["no-judge"],
  onResult: (progress) => console.log(renderProgress(progress)),
});

mkdirSync(values.out, { recursive: true });
const stamp = report.startedAt.replaceAll(/[:.]/g, "-");
const base = path.join(values.out, `evals-${stamp}`);
writeFileSync(`${base}.md`, renderReport(report));
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));

// The headline (result, cost, counts); the per-persona lines are already above.
console.log(`\n${renderReport(report).split("\n").slice(0, 6).join("\n")}`);
console.log(`\nFull report: ${base}.md`);
process.exitCode = report.failed === 0 && !report.abortedByCostCap ? 0 : 1;
