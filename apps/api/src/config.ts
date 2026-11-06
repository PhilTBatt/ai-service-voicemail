import { z } from "zod";

// Winston's default (npm) levels, most to least severe.
const LOG_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // Optional outside production so the API runs without a voice platform (tests use the
    // fake). Production can't answer calls without it, so there it's required.
    RETELL_API_KEY: z.string().min(1).optional(),
    // Twilio: same rule. The webhook routes need PUBLIC_BASE_URL, because Twilio signs the
    // exact public URL it called; it's never rebuilt from the request behind a proxy.
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(/^AC[0-9a-fA-F]{32}$/, "expected AC + 32 hex characters")
      .optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    // Buying numbers costs money: off unless an environment says otherwise.
    TWILIO_PURCHASES_ENABLED: z.enum(["true", "false"]).default("false"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    for (const name of [
      "RETELL_API_KEY",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "PUBLIC_BASE_URL",
    ] as const) {
      if (env[name] === undefined) {
        ctx.addIssue({ code: "custom", path: [name], message: "required in production" });
      }
    }
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    retellApiKey: env.RETELL_API_KEY,
    twilio:
      env.TWILIO_ACCOUNT_SID !== undefined && env.TWILIO_AUTH_TOKEN !== undefined
        ? {
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_AUTH_TOKEN,
            purchasesEnabled: env.TWILIO_PURCHASES_ENABLED === "true",
          }
        : undefined,
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, ""),
  }));

export type Config = z.output<typeof envSchema>;

/** Thrown when the environment is invalid. Names the variables, never their values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // `KEY=` in a .env file arrives as "", so treat empty values as unset and let defaults apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));

  const result = envSchema.safeParse(present);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0]);
    return present[name] === undefined
      ? `${name} is missing`
      : `${name} is invalid: ${issue.message}`;
  });
  throw new ConfigError(problems);
}
