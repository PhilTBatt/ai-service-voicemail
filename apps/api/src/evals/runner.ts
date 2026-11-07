// Runs the personas through the simulation, the real extraction prompt, the guardrail and
// script checks, and the judge (BUILD_PLAN Step 7), under one cost cap.
import type { AgentDefinition } from "../core/agent.ts";
import {
  buildExtractionPrompt,
  callExtractionSchema,
  type CallExtraction,
  type ExtractionContext,
} from "../core/extraction.ts";
import type { LlmProvider } from "../providers/llm.ts";
import { assertCall, type Verdict } from "./assertions.ts";
import { CostCapExceededError, CostMeter } from "./cost.ts";
import { judgeSummary, type JudgeVerdict } from "./judge.ts";
import type { Persona } from "./persona.ts";
import { simulateCall, type SimulationResult } from "./simulate.ts";

export interface EvalRunOptions {
  definition: AgentDefinition;
  context: ExtractionContext;
  personas: Persona[];
  llm: LlmProvider;
  capPence: number;
  /** The judge costs one more model call per persona; off for quick prompt iterations. */
  judge?: boolean;
  gbpPerUsd?: number;
  now?: () => Date;
}

export interface PersonaResult {
  id: string;
  name: string;
  passed: boolean;
  verdicts: Verdict[];
  simulation: SimulationResult | null;
  extraction: CallExtraction | null;
  judge: JudgeVerdict | null;
  /** Set when the persona couldn't be run at all (a model error, not a failed check). */
  error?: string;
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  model: string;
  results: PersonaResult[];
  passed: number;
  failed: number;
  /** Personas never run because the cap was hit. */
  skipped: string[];
  cost: {
    estimatedPence: number;
    capPence: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
  };
  abortedByCostCap: boolean;
}

/** "07700 900101" -> "+447700900101" (persona phones are written the way a caller says them). */
function toE164(ukNumber: string): string {
  return ukNumber.replaceAll(/\s+/g, "").replace(/^0/, "+44");
}

export async function runEvals({
  definition,
  context,
  personas,
  llm,
  capPence,
  judge = true,
  gbpPerUsd,
  now = () => new Date(),
}: EvalRunOptions): Promise<EvalReport> {
  const startedAt = now().toISOString();
  const meter = new CostMeter({
    model: llm.model,
    capPence,
    ...(gbpPerUsd !== undefined && { gbpPerUsd }),
  });
  const results: PersonaResult[] = [];
  const skipped: string[] = [];
  let abortedByCostCap = false;

  for (const [index, persona] of personas.entries()) {
    if (abortedByCostCap) {
      skipped.push(persona.id);
      continue;
    }
    try {
      results.push(await runPersona(persona));
    } catch (error) {
      if (error instanceof CostCapExceededError) {
        abortedByCostCap = true;
        results.push({
          id: persona.id,
          name: persona.name,
          passed: false,
          verdicts: [],
          simulation: null,
          extraction: null,
          judge: null,
          error: error.message,
        });
        skipped.push(...personas.slice(index + 1).map((p) => p.id));
        break;
      }
      results.push({
        id: persona.id,
        name: persona.name,
        passed: false,
        verdicts: [],
        simulation: null,
        extraction: null,
        judge: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    startedAt,
    finishedAt: now().toISOString(),
    model: llm.model,
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    skipped,
    cost: {
      estimatedPence: meter.estimatedPence,
      capPence,
      inputTokens: meter.inputTokens,
      outputTokens: meter.outputTokens,
      calls: meter.calls,
    },
    abortedByCostCap,
  };

  async function runPersona(persona: Persona): Promise<PersonaResult> {
    const simulation = await simulateCall({ llm, meter }, definition, persona);

    // The same extraction prompt and schema the pipeline uses, so the eval tests them too.
    const extracted = await llm.extract({
      ...buildExtractionPrompt(simulation.transcript, {
        ...context,
        callerNumber: persona.caller.phone ? toE164(persona.caller.phone) : null,
      }),
      schema: callExtractionSchema,
    });
    meter.add(extracted.usage);
    const extraction = extracted.ok ? extracted.value : null;

    const verdict =
      judge && extraction
        ? await judgeSummary(llm, meter, simulation.transcript, extraction)
        : null;
    const verdicts = assertCall(definition, persona, simulation, extraction, verdict);
    if (!extracted.ok) {
      verdicts.push({ check: "extraction", pass: false, detail: `extraction ${extracted.reason}` });
    }
    return {
      id: persona.id,
      name: persona.name,
      passed: verdicts.every((v) => v.pass),
      verdicts,
      simulation,
      extraction,
      judge: verdict,
    };
  }
}
