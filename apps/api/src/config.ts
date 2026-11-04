import { z } from "zod";

// Winston's default (npm) levels, most to least severe.
const LOG_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
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
