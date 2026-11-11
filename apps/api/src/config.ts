import { z } from "zod";
import { parseAllowlist } from "./core/outbound-allowlist.ts";

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
    // The Retell key marked "webhook" in its dashboard, if that isn't RETELL_API_KEY: only that
    // one verifies the signatures on Retell's webhooks and mid-call function requests.
    RETELL_WEBHOOK_KEY: z.string().min(1).optional(),
    // Twilio: same rule. The webhook routes need PUBLIC_BASE_URL, because Twilio signs the
    // exact public URL it called; it's never rebuilt from the request behind a proxy.
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(/^AC[0-9a-fA-F]{32}$/, "expected AC + 32 hex characters")
      .optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    // Another address the API also answers at, once it has its own domain (RUNBOOK section 16):
    // Twilio's signatures made for it are accepted too, so calls keep working until the number
    // is pointed at the new address (and the fallback TwiML Bin, which names the old one, keeps
    // working after), and a dashboard page opened there is sent on to DASHBOARD_ORIGIN, the only
    // address its logins work at. Set by infra/main.bicep.
    ALTERNATE_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    // Buying numbers costs money: off unless an environment says otherwise.
    TWILIO_PURCHASES_ENABLED: z.enum(["true", "false"]).default("false"),
    // UK numbers need an approved regulatory bundle and address (decision 009).
    TWILIO_BUNDLE_SID: z
      .string()
      .regex(/^BU[0-9a-fA-F]{32}$/, "expected BU + 32 hex characters")
      .optional(),
    TWILIO_ADDRESS_SID: z
      .string()
      .regex(/^AD[0-9a-fA-F]{32}$/, "expected AD + 32 hex characters")
      .optional(),
    // The TwiML Bin that plays the static voicemail (npm run twiml:fallback): the number's fallback URL.
    FALLBACK_VOICEMAIL_URL: z.url({ protocol: /^https$/ }).optional(),
    // The LLM for post-call extraction (BUILD_PLAN Step 5). The model is pinned here so a
    // provider-side change never silently alters what gets extracted.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Outside production, SMS and email go only to these E.164 numbers and email addresses
    // (comma-separated). CLAUDE.md rule 4: never bypassed.
    OUTBOUND_ALLOWLIST: z.string().optional(),
    // The shared notification sender: a UK mobile number in E.164, or an alphanumeric ID.
    TWILIO_SMS_FROM: z
      .string()
      .regex(
        /^(\+[1-9]\d{7,14}|[A-Za-z][A-Za-z0-9 ]{0,10})$/,
        "expected an E.164 number or an alphanumeric sender ID (max 11)",
      )
      .optional(),
    // Email (decision 010: Postmark). The token is a secret; From must be an address at a domain
    // Postmark has verified. Optional in development; required in production.
    POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
    EMAIL_FROM: z.email().optional(),
    EMAIL_REPLY_TO: z.email().optional(),
    // Where alerts are emailed (alert-email.ts), besides the log. Needs the email settings.
    ALERT_EMAIL: z.email().optional(),
    // Payments (decision 019: GoCardless Direct Debit). The access token is a secret from the
    // dashboard's Developers page; a sandbox token only works against the sandbox and vice
    // versa, so the environment says which. The webhook secret is the endpoint's, from
    // Developers > Webhooks; without it, payment webhooks are refused.
    GOCARDLESS_ACCESS_TOKEN: z.string().min(1).optional(),
    GOCARDLESS_ENVIRONMENT: z.enum(["sandbox", "live"]).default("sandbox"),
    GOCARDLESS_WEBHOOK_SECRET: z.string().min(16).optional(),
    // VAT (decision 019): off until Brockersby is VAT registered. Both or neither: the
    // registration number (shown on receipts) and the UK date VAT is charged from; a billing
    // month that starts on or after it has 20% added.
    VAT_REGISTRATION_NUMBER: z
      .string()
      .regex(/^GB\d{9}(\d{3})?$/, "expected a UK VAT number like GB123456789")
      .optional(),
    VAT_REGISTRATION_FROM: z.iso.date().optional(),
    // The password in the Basic-auth webhook URL registered at Postmark (username "postmark"):
    // https://postmark:<secret>@<public host>/webhooks/postmark. Postmark doesn't sign webhooks.
    POSTMARK_WEBHOOK_SECRET: z.string().min(16).optional(),
    // Signs the call links in texts and emails (core/signed-links.ts). 32+ random characters.
    SIGNING_SECRET: z.string().min(32, "expected at least 32 characters").optional(),
    // Cross-tenant work: the worker (retention, reconciliation) and the API's dashboard views
    // that span tenants (the tenant list, the admin screens). Only db/cross-tenant.ts uses it.
    ADMIN_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    // Dashboard login (decision 012: Clerk). Verifies session tokens, and looks up a person's
    // email on their first login. Without it (or ADMIN_DATABASE_URL) the dashboard API is off.
    CLERK_SECRET_KEY: z
      .string()
      .startsWith("sk_", "expected a Clerk secret key (sk_...)")
      .optional(),
    // Optional: Clerk's JWT public key (PEM), so checking a login token needs no call to Clerk.
    // Not a secret. On one line, its line breaks can be written as \n.
    CLERK_JWT_KEY: z
      .string()
      .transform((key) => key.replaceAll("\\n", "\n"))
      .pipe(z.string().startsWith("-----BEGIN PUBLIC KEY-----", "expected a PEM public key"))
      .optional(),
    // The site the dashboard is served from. Login tokens made for any other site are refused.
    // Defaults to the local dev server (npm run dev:web). http or https only: without a scheme,
    // "localhost:5173" parses as a URL whose scheme is "localhost", its origin is "null", and
    // every login would be refused with nothing in the start-up log to say why.
    DASHBOARD_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
    // The built dashboard (apps/web/dist), served by the API at /. Set in the container image
    // only: in development the dashboard comes from its own dev server (npm run dev:web).
    DASHBOARD_DIST: z.string().min(1).optional(),
    LLM_MODEL: z.string().min(1).default("claude-haiku-5-5"),
    // Share of processed calls whose summary is checked by the hallucination judge (Step 7):
    // 0 (off) to 1 (every call). Off by default; each check is one more model call.
    JUDGE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  })
  .superRefine((env, ctx) => {
    // The same address twice would send the dashboard round a loop of redirects. Only when both
    // parse: zod runs this even after a field failed, and a malformed one is reported as such.
    if (
      env.ALTERNATE_BASE_URL !== undefined &&
      env.PUBLIC_BASE_URL !== undefined &&
      URL.canParse(env.ALTERNATE_BASE_URL) &&
      URL.canParse(env.PUBLIC_BASE_URL) &&
      new URL(env.ALTERNATE_BASE_URL).host === new URL(env.PUBLIC_BASE_URL).host
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ALTERNATE_BASE_URL"],
        message: "must be a different address from PUBLIC_BASE_URL",
      });
    }
    // The two go together: name whichever one is missing.
    if ((env.VAT_REGISTRATION_NUMBER === undefined) !== (env.VAT_REGISTRATION_FROM === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [
          env.VAT_REGISTRATION_NUMBER === undefined
            ? "VAT_REGISTRATION_NUMBER"
            : "VAT_REGISTRATION_FROM",
        ],
        message: "VAT_REGISTRATION_NUMBER and VAT_REGISTRATION_FROM go together",
      });
    }
    if (env.NODE_ENV !== "production") return;
    for (const name of [
      "RETELL_API_KEY",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "PUBLIC_BASE_URL",
      "FALLBACK_VOICEMAIL_URL",
      "ANTHROPIC_API_KEY",
      "ADMIN_DATABASE_URL",
      "TWILIO_SMS_FROM",
      "SIGNING_SECRET",
      "POSTMARK_SERVER_TOKEN",
      "EMAIL_FROM",
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
    retellWebhookKey: env.RETELL_WEBHOOK_KEY,
    twilio:
      env.TWILIO_ACCOUNT_SID !== undefined && env.TWILIO_AUTH_TOKEN !== undefined
        ? {
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_AUTH_TOKEN,
            purchasesEnabled: env.TWILIO_PURCHASES_ENABLED === "true",
            ...(env.TWILIO_BUNDLE_SID !== undefined && { bundleSid: env.TWILIO_BUNDLE_SID }),
            ...(env.TWILIO_ADDRESS_SID !== undefined && { addressSid: env.TWILIO_ADDRESS_SID }),
          }
        : undefined,
    // Every trailing slash, not just one: "https://host//" left one behind, so the webhook URLs
    // given to Twilio and Retell had "//" in them, and the API's routes don't answer those.
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, ""),
    alternateBaseUrl: env.ALTERNATE_BASE_URL?.replace(/\/+$/, ""),
    fallbackVoicemailUrl: env.FALLBACK_VOICEMAIL_URL,
    adminDatabaseUrl: env.ADMIN_DATABASE_URL,
    signingSecret: env.SIGNING_SECRET,
    clerkSecretKey: env.CLERK_SECRET_KEY,
    clerkJwtKey: env.CLERK_JWT_KEY,
    // An origin is scheme, host and port: a trailing slash or path would never match a token.
    dashboardOrigin: new URL(env.DASHBOARD_ORIGIN ?? "http://localhost:5173").origin,
    dashboardDist: env.DASHBOARD_DIST,
    email:
      env.POSTMARK_SERVER_TOKEN !== undefined && env.EMAIL_FROM !== undefined
        ? {
            serverToken: env.POSTMARK_SERVER_TOKEN,
            from: env.EMAIL_FROM,
            ...(env.EMAIL_REPLY_TO !== undefined && { replyTo: env.EMAIL_REPLY_TO }),
          }
        : undefined,
    postmarkWebhookSecret: env.POSTMARK_WEBHOOK_SECRET,
    alertEmail: env.ALERT_EMAIL,
    payments:
      env.GOCARDLESS_ACCESS_TOKEN !== undefined
        ? {
            accessToken: env.GOCARDLESS_ACCESS_TOKEN,
            environment: env.GOCARDLESS_ENVIRONMENT,
            webhookSecret: env.GOCARDLESS_WEBHOOK_SECRET,
          }
        : undefined,
    vat:
      env.VAT_REGISTRATION_NUMBER !== undefined && env.VAT_REGISTRATION_FROM !== undefined
        ? { number: env.VAT_REGISTRATION_NUMBER, from: env.VAT_REGISTRATION_FROM }
        : undefined,
    outbound: { nodeEnv: env.NODE_ENV, allowlist: parseAllowlist(env.OUTBOUND_ALLOWLIST) },
    sms:
      env.TWILIO_ACCOUNT_SID !== undefined &&
      env.TWILIO_AUTH_TOKEN !== undefined &&
      env.TWILIO_SMS_FROM !== undefined
        ? {
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_AUTH_TOKEN,
            from: env.TWILIO_SMS_FROM,
          }
        : undefined,
    llm: env.ANTHROPIC_API_KEY
      ? {
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.LLM_MODEL,
          judgeSampleRate: env.JUDGE_SAMPLE_RATE,
        }
      : undefined,
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

/**
 * The Retell adapter's settings beyond the API key: where Retell sends call events and
 * mid-call function requests once there's a public URL, and the key that verifies them.
 */
export function retellUrls(config: Pick<Config, "publicBaseUrl" | "retellWebhookKey">) {
  return {
    ...(config.retellWebhookKey !== undefined && { webhookKey: config.retellWebhookKey }),
    ...(config.publicBaseUrl && {
      webhookUrl: `${config.publicBaseUrl}/webhooks/voice/retell`,
      functionUrl: `${config.publicBaseUrl}/webhooks/voice/retell/function`,
    }),
  };
}
