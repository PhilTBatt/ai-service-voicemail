// A text simulation of a call (BUILD_PLAN Step 7): one model plays the caller from a
// persona, another plays the agent from the same AgentDefinition the voice platform gets.
// A small engine stands in for the platform's flow: it speaks the opening and the closing
// line itself, speaks a fixed script word for word when the agent model says its trigger
// applies, keeps a script from firing on two consecutive turns (the flow's cool-down) and a
// once-a-call script from firing twice, and handles silence the way the agent limits do (one
// prompt, then end the call).
//
// This tests the prompt and the scripts' triggers, not the platform. The platform's own
// batch tests are the authority for what Retell actually says (decision 007).
import { z } from "zod";
import type { AgentDefinition, FixedScript } from "../core/agent.ts";
import type { LlmProvider } from "../providers/llm.ts";
import type { TranscriptTurn } from "../providers/voice.ts";
import type { CostMeter } from "./cost.ts";
import type { Persona } from "./persona.ts";

export type CallEnding = "close" | "caller" | "silence" | "max-turns";

export interface SimulationResult {
  transcript: TranscriptTurn[];
  ending: CallEnding;
  scriptsSpoken: FixedScript["id"][];
}

export interface SimulationDeps {
  llm: LlmProvider;
  meter: CostMeter;
}

/** What the agent model decides each turn. */
export const agentTurnSchema = z.object({
  trigger: z.enum(["gas_emergency", "danger", "water_leak", "are_you_ai", "none"]),
  reply: z.string(),
  done: z.boolean(),
});

/** What the caller model decides each turn. */
export const callerTurnSchema = z.object({
  say: z.string(),
  hangUp: z.boolean(),
});

export function agentSystemPrompt(definition: AgentDefinition, variables: Record<string, string>) {
  const instructions = definition.instructions.replaceAll(
    /\{\{(\w+)\}\}/g,
    (match, name: string) => (name in variables ? JSON.stringify(variables[name]) : match),
  );
  const triggers = definition.scripts.map((s) => `  - ${s.id}: ${s.trigger}`).join("\n");
  return `${instructions}

## How this simulation works
You are being run as a text simulation of the phone agent, one turn at a time. The system has already spoken the opening and speaks the fixed safety messages for you. Each turn, decide:
- "trigger": if the conversation so far meets one of these conditions, name it and the system speaks the fixed message word for word (never write it yourself):
${triggers}
  Otherwise "none".
- "reply": what you'd say next if no fixed message were spoken. Always fill it in, even when you name a trigger: the system may hold a message back (it never plays one twice in a row) and then speaks your reply instead. One or two short sentences, one question at a time, natural British English.
- "done": true when this holds: ${definition.closeWhen}. The system then speaks the closing line straight after your reply, so a reply with "done" mustn't ask anything.
If the caller has said nothing (shown as "[silence]"), reply with one short prompt to check they're still there.`;
}

export function callerSystemPrompt(persona: Persona) {
  const { caller } = persona;
  const details = [
    caller.name !== null && `Your name is ${caller.name}.`,
    caller.phone !== null && `Your phone number is ${caller.phone}.`,
    caller.postcode !== null && `Your postcode is ${caller.postcode}.`,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
  return `You are role-playing a caller on the phone to a tradesperson's answering service, which is answered by an AI assistant. Stay in character throughout.

Your situation: ${caller.brief}
${details ? `${details} Give these details only when asked, one at a time, the way people do on the phone.` : "You don't give personal details."}

Speak as a real caller would: one or two sentences at a time, informal British English, no stage directions, no narration. Never say you are an AI or a simulation. Set "hangUp" to true only once the assistant has said goodbye, or when your situation says you'd give up and hang up (or do as you're told and hang up). Giving your last detail isn't the end of the call: wait for the assistant to wind it up.`;
}

function renderConversation(transcript: TranscriptTurn[]): string {
  return transcript
    .map(
      (turn) =>
        `${turn.role === "agent" ? "Assistant" : "Caller"}: ${turn.text === "" ? "[silence]" : turn.text}`,
    )
    .join("\n");
}

export async function simulateCall(
  { llm, meter }: SimulationDeps,
  definition: AgentDefinition,
  persona: Persona,
): Promise<SimulationResult> {
  const transcript: TranscriptTurn[] = [{ role: "agent", text: definition.opening }];
  const scriptsSpoken: FixedScript["id"][] = [];
  const scriptsById = new Map<FixedScript["id"], FixedScript>(
    definition.scripts.map((s) => [s.id, s]),
  );
  // The caller ID the platform would pass: the persona's phone, or unknown when withheld.
  const agentSystem = agentSystemPrompt(definition, {
    caller_number: persona.caller.phone ?? "unknown",
    ...persona.variables,
  });
  const callerSystem = callerSystemPrompt(persona);
  const maxTurns = persona.expect.maxTurns;

  let callerTurns = 0;
  let consecutiveSilences = 0;
  let lastScript: FixedScript["id"] | null = null;

  while (transcript.length < maxTurns) {
    // ── The caller speaks ────────────────────────────────────────────────────────────
    let said: string;
    let hangUp = false;
    if (persona.caller.silent) {
      said = "";
    } else if (callerTurns === 0 && persona.caller.opening !== null) {
      said = persona.caller.opening;
    } else {
      const result = await llm.extract({
        system: callerSystem,
        user: `${renderConversation(transcript)}\n\nWhat do you say next?`,
        schema: callerTurnSchema,
      });
      meter.add(result.usage);
      if (!result.ok) throw new Error(`Caller model gave ${result.reason} for ${persona.id}`);
      said = result.value.say.trim();
      hangUp = result.value.hangUp;
    }
    callerTurns += 1;
    transcript.push({ role: "caller", text: said });
    if (
      hangUp ||
      (persona.caller.hangsUpAfterTurns !== null && callerTurns >= persona.caller.hangsUpAfterTurns)
    ) {
      return { transcript, ending: "caller", scriptsSpoken };
    }
    if (transcript.length >= maxTurns) break;

    // ── Silence: one prompt, then the call ends ──────────────────────────────────────
    if (said === "") {
      consecutiveSilences += 1;
      if (consecutiveSilences >= 2) return { transcript, ending: "silence", scriptsSpoken };
    } else {
      consecutiveSilences = 0;
    }

    // ── The agent decides ────────────────────────────────────────────────────────────
    const decision = await llm.extract({
      system: agentSystem,
      user: `${renderConversation(transcript)}\n\nDecide your next move.`,
      schema: agentTurnSchema,
    });
    meter.add(decision.usage);
    if (!decision.ok) throw new Error(`Agent model gave ${decision.reason} for ${persona.id}`);
    const { trigger, reply, done } = decision.value;

    // Held back, so the reply is spoken instead: the same script on consecutive turns (the
    // flow's cool-down), or a once-a-call script a second time.
    const named = trigger === "none" ? undefined : scriptsById.get(trigger);
    const script: FixedScript | undefined =
      named &&
      named.id !== lastScript &&
      !(named.oncePerCall === true && scriptsSpoken.includes(named.id))
        ? named
        : undefined;
    if (script) {
      // The flow speaks the script, uninterrupted, then returns to taking the message.
      transcript.push({ role: "agent", text: script.text });
      scriptsSpoken.push(script.id);
      lastScript = script.id;
      continue;
    }
    lastScript = null;
    if (reply.trim() !== "") transcript.push({ role: "agent", text: reply.trim() });
    if (done) {
      // The flow moves to the end node, which speaks the closing line.
      transcript.push({ role: "agent", text: definition.close });
      return { transcript, ending: "close", scriptsSpoken };
    }
  }
  return { transcript, ending: "max-turns", scriptsSpoken };
}
