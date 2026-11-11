// Caller personas (BUILD_PLAN Step 7): who rings, what they want, how they behave, and what
// the agent must do about it. They live as YAML in evals/personas/ at the repo root so Phil
// can read and edit them without touching code. Fictional details only (CLAUDE.md).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { TRADES } from "@callmate/shared";
import { parse } from "yaml";
import { z } from "zod";
import { URGENCIES } from "../core/extraction.ts";

const SCRIPT_IDS = ["gas_emergency", "danger", "water_leak", "are_you_ai"] as const;
const ENDINGS = ["close", "caller", "silence", "any"] as const;
export type Ending = (typeof ENDINGS)[number];

export const personaSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "lower-case words and dashes"),
  name: z.string().min(1),
  description: z.string().min(1),
  /** The trade of the business rung (evals/businesses.ts): the demo plumber unless given. */
  trade: z.enum(TRADES).default("plumber"),
  caller: z.object({
    /** The role-play brief for the model playing the caller. */
    brief: z.string().min(1),
    name: z.string().nullable().default(null),
    /** As a caller would say it ("07700 900123"); fictional (Ofcom drama range). */
    phone: z.string().nullable().default(null),
    postcode: z.string().nullable().default(null),
    /** The caller's first words, if fixed; otherwise the model improvises from the brief. */
    opening: z.string().nullable().default(null),
    /** A caller who says nothing at all. */
    silent: z.boolean().default(false),
    /** Hang up after this many of their own turns, whatever the agent says. */
    hangsUpAfterTurns: z.number().int().positive().nullable().default(null),
  }),
  /** The per-call variables our server would supply. */
  variables: z
    .object({
      open_now: z.enum(["yes", "no"]),
      holiday_mode: z.enum(["yes", "no"]),
      // What the server sends while away (core/availability.ts holidayUntilWords).
      holiday_until: z.string().default("until further notice"),
    })
    .default({ open_now: "yes", holiday_mode: "no", holiday_until: "not away" }),
  expect: z.object({
    /** Fixed scripts that must be spoken, word for word, as a whole turn. */
    scripts: z.array(z.enum(SCRIPT_IDS)).default([]),
    /** Fixed scripts that must not be spoken (over-triggering is otherwise allowed). */
    forbidScripts: z.array(z.enum(SCRIPT_IDS)).default([]),
    urgency: z.enum(URGENCIES).nullable().default(null),
    /** Whether the extraction should say the caller asked about price. */
    priceAsked: z.boolean().nullable().default(null),
    /** Expected extraction; a null value means "must not be extracted". Omit a key to skip it. */
    fields: z
      .object({
        callerName: z.string().nullable().optional(),
        callbackNumber: z.string().nullable().optional(),
        postcode: z.string().nullable().optional(),
      })
      .default({}),
    /** Substrings that must appear among the extraction's flags (case-insensitive). */
    flagsInclude: z.array(z.string().min(1)).default([]),
    /**
     * How the call should end: the closing line, the caller hanging up, silence, or any. A list
     * allows each: [close, caller] for a caller who may do as the 999 message says and hang up.
     */
    ending: z.union([z.enum(ENDINGS), z.array(z.enum(ENDINGS)).min(1)]).default("any"),
    /** Total turns (agent and caller) the call must finish within. */
    maxTurns: z.number().int().positive().default(20),
  }),
});
export type Persona = z.infer<typeof personaSchema>;

/** The personas BUILD_PLAN Step 7 requires. The loader fails if any is missing. */
export const REQUIRED_PERSONAS = [
  "gas-smell",
  "gas-in-passing",
  "co-alarm",
  "sparks-burning-smell",
  "water-through-ceiling",
  "price-pusher",
  "appointment-pusher",
  "wants-a-human",
  "abusive-caller",
  "silent-caller",
  "spam-robocall",
  "non-english-speaker",
  "existing-customer-chasing",
  "wrong-number",
] as const;

/** evals/personas at the repo root, from wherever this file is run. */
export const PERSONAS_DIR = path.resolve(import.meta.dirname, "../../../../evals/personas");

export function parsePersona(yamlText: string, source: string): Persona {
  const result = personaSchema.safeParse(parse(yamlText));
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid persona ${source}:\n  ${problems.join("\n  ")}`);
  }
  return result.data;
}

export function loadPersonas(dir = PERSONAS_DIR): Persona[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();
  const personas = files.map((file) =>
    parsePersona(readFileSync(path.join(dir, file), "utf8"), file),
  );
  const ids = new Set(personas.map((p) => p.id));
  if (ids.size !== personas.length) throw new Error("Duplicate persona ids");
  const missing = REQUIRED_PERSONAS.filter((id) => !ids.has(id));
  if (missing.length > 0) throw new Error(`Missing required personas: ${missing.join(", ")}`);
  return personas;
}
