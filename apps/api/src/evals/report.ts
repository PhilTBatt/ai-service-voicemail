// The eval report as Markdown, for the PR and for reading after a run, and the one-line
// progress a run prints as each persona finishes.
import type { EvalProgress, EvalReport } from "./runner.ts";

/** "[ 3/24] pass  Gas smell (2p so far)", or with the failed checks or the error after it. */
export function renderProgress({ result, done, total, spentPence }: EvalProgress): string {
  const outcome = result.error ? "ERROR" : result.passed ? "pass" : "FAIL";
  const why =
    result.error ??
    result.verdicts
      .filter((v) => !v.pass)
      .map((v) => v.check)
      .join(", ");
  const counter = `[${String(done).padStart(String(total).length)}/${total}]`;
  return `${counter} ${outcome.padEnd(5)} ${result.name}${why ? `: ${why}` : ""} (${spentPence}p so far)`;
}

export function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  const status = report.abortedByCostCap
    ? "ABORTED: cost cap"
    : report.failed === 0
      ? "PASS"
      : `FAIL (${report.failed} of ${report.results.length})`;
  lines.push(`# Eval run: ${status}`);
  lines.push("");
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Model: ${report.model}`);
  lines.push(
    `- Cost: about ${report.cost.estimatedPence}p of a ${report.cost.capPence}p cap (${report.cost.calls} model calls, ${report.cost.inputTokens} in / ${report.cost.outputTokens} out tokens)`,
  );
  lines.push(
    `- Passed ${report.passed}, failed ${report.failed}, skipped ${report.skipped.length}`,
  );
  lines.push("");
  lines.push("| Persona | Result | Failed checks |");
  lines.push("| --- | --- | --- |");
  for (const r of report.results) {
    const failed = r.error
      ? `error: ${r.error}`
      : r.verdicts
          .filter((v) => !v.pass)
          .map((v) => v.check)
          .join(", ");
    lines.push(`| ${r.name} | ${r.passed ? "pass" : "FAIL"} | ${failed} |`);
  }
  for (const id of report.skipped) lines.push(`| ${id} | skipped | cost cap |`);
  lines.push("");

  for (const r of report.results) {
    lines.push(`## ${r.name} (${r.id}): ${r.passed ? "pass" : "FAIL"}`);
    lines.push("");
    if (r.error) lines.push(`Error: ${r.error}`, "");
    for (const v of r.verdicts) {
      lines.push(
        `- ${v.pass ? "✅" : "❌"} ${v.check}${v.detail && !v.pass ? `: ${v.detail}` : ""}`,
      );
    }
    if (r.extraction) {
      lines.push("", "Extraction:", "", "```json", JSON.stringify(r.extraction, null, 2), "```");
    }
    if (r.simulation) {
      lines.push("", `Transcript (ended: ${r.simulation.ending}):`, "");
      for (const turn of r.simulation.transcript) {
        lines.push(
          `> **${turn.role === "agent" ? "Assistant" : "Caller"}:** ${turn.text || "[silence]"}`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
