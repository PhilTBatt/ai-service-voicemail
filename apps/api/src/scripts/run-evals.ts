// Runs the eval personas against the current prompt with the real model, under a cost cap.
// Run from the repo root: npm run evals [-- --persona gas-smell --cap-pence 50 --no-judge]
// Spends Anthropic credit (a few pence per run at the default cap); needs ANTHROPIC_API_KEY.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { buildAgentDefinition } from "../core/prompt-builder.ts";
import { loadPersonas, PERSONAS_DIR } from "../evals/persona.ts";
import { renderReport } from "../evals/report.ts";
import { runEvals } from "../evals/runner.ts";
import { AnthropicLlmProvider } from "../providers/anthropic.ts";
import { sampleProfile } from "../testing/profile-fixture.ts";

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

// The demo tenant's profile: fictional, and the one Phil's test calls use.
const profile = sampleProfile({ isDemo: false });
const report = await runEvals({
  definition: buildAgentDefinition(profile),
  context: { businessName: profile.businessName, tradespersonName: profile.tradespersonName },
  personas: selected,
  llm: new AnthropicLlmProvider(config.llm),
  capPence,
  judge: !values["no-judge"],
});

mkdirSync(values.out, { recursive: true });
const stamp = report.startedAt.replaceAll(/[:.]/g, "-");
const base = path.join(values.out, `evals-${stamp}`);
writeFileSync(`${base}.md`, renderReport(report));
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));

console.log(
  renderReport(report)
    .split("\n")
    .slice(0, 8 + report.results.length + report.skipped.length)
    .join("\n"),
);
console.log(`\nFull report: ${base}.md`);
process.exitCode = report.failed === 0 && !report.abortedByCostCap ? 0 : 1;
