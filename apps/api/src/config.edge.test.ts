// The edges of loadConfig: every setting's bad values, the boundaries of its ranges, and the
// mistakes a person makes by hand in .env or Key Vault. config.test.ts covers the main paths;
// this file is about the values one character away from right.
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, retellUrls } from "./config.ts";

const valid = { DATABASE_URL: "postgres://app@localhost:5432/callmate" };
const SID = "AC" + "a".repeat(32);

function problemsFor(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected loadConfig to throw a ConfigError");
}

/** Everything production needs, with stand-ins: the base the production tests vary. */
const PRODUCTION = {
  ...valid,
  NODE_ENV: "production",
  RETELL_API_KEY: "key_for_tests",
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: "token_for_tests",
  PUBLIC_BASE_URL: "https://callmate.example.com",
  FALLBACK_VOICEMAIL_URL: "https://handler.twilio.com/twiml/EH0",
  ANTHROPIC_API_KEY: "key_for_tests",
  ADMIN_DATABASE_URL: "postgres://admin@localhost/callmate",
  TWILIO_SMS_FROM: "AnswerMate",
  SIGNING_SECRET: "x".repeat(32),
  POSTMARK_SERVER_TOKEN: "token_for_tests",
  EMAIL_FROM: "calls@example.com",
};

describe("PORT", () => {
  it.each([
    ["1", 1],
    ["65535", 65535],
    ["3000", 3000],
  ])("takes %s", (value, port) => {
    expect(loadConfig({ ...valid, PORT: value }).port).toBe(port);
  });

  it.each(["0", "65536", "-1", "3000.1", "port", "Infinity"])("refuses %s", (value) => {
    expect(problemsFor({ ...valid, PORT: value })).toEqual([
      expect.stringMatching(/^PORT is invalid/),
    ]);
  });
});

describe("LOG_LEVEL", () => {
  it.each(["error", "warn", "info", "http", "verbose", "debug", "silly"])("takes %s", (level) => {
    expect(loadConfig({ ...valid, LOG_LEVEL: level }).logLevel).toBe(level);
  });

  // A level in capitals is a likely typo; winston's names are lower case, so it's refused
  // rather than quietly logging at the default.
  it("refuses a level in capitals", () => {
    expect(problemsFor({ ...valid, LOG_LEVEL: "DEBUG" })[0]).toMatch(/^LOG_LEVEL is invalid/);
  });
});

describe("NODE_ENV", () => {
  it.each(["development", "test", "production"])("takes %s", (nodeEnv) => {
    const env = nodeEnv === "production" ? PRODUCTION : { ...valid, NODE_ENV: nodeEnv };
    expect(loadConfig(env).nodeEnv).toBe(nodeEnv);
  });

  it("refuses PRODUCTION in capitals rather than treating it as development", () => {
    // Treated as development, the outbound allowlist would apply in production: safe, but every
    // text to a customer would be refused. Refusing to start says what's wrong at once.
    expect(problemsFor({ ...valid, NODE_ENV: "Production" })[0]).toMatch(/^NODE_ENV is invalid/);
  });

  it("gives the outbound policy the same environment the config has", () => {
    expect(loadConfig(PRODUCTION).outbound.nodeEnv).toBe("production");
    expect(loadConfig({ ...valid, NODE_ENV: "test" }).outbound.nodeEnv).toBe("test");
  });
});

describe("DATABASE_URL and ADMIN_DATABASE_URL", () => {
  it.each(["http://localhost/callmate", "mysql://localhost/callmate", "localhost:5432"])(
    "refuses %s as the app's database",
    (url) => {
      expect(problemsFor({ DATABASE_URL: url })[0]).toMatch(/^DATABASE_URL is invalid/);
    },
  );

  it("refuses an admin URL that isn't Postgres", () => {
    expect(problemsFor({ ...valid, ADMIN_DATABASE_URL: "https://example.com" })[0]).toMatch(
      /^ADMIN_DATABASE_URL is invalid/,
    );
  });

  it("passes the admin URL through when set, and leaves it unset otherwise", () => {
    const admin = "postgresql://admin@localhost/callmate";
    expect(loadConfig({ ...valid, ADMIN_DATABASE_URL: admin }).adminDatabaseUrl).toBe(admin);
    expect(loadConfig(valid).adminDatabaseUrl).toBeUndefined();
  });
});

describe("production", () => {
  it("starts with exactly the required settings", () => {
    const config = loadConfig(PRODUCTION);
    expect(config.nodeEnv).toBe("production");
    expect(config.twilio).toBeDefined();
    expect(config.sms).toBeDefined();
    expect(config.email).toBeDefined();
    expect(config.llm).toBeDefined();
    // Purchases stay off in production too, until the setting says otherwise.
    expect(config.twilio?.purchasesEnabled).toBe(false);
    // Optional in production: billing, VAT, alert emails and the dashboard login.
    expect(config.payments).toBeUndefined();
    expect(config.vat).toBeUndefined();
    expect(config.alertEmail).toBeUndefined();
    expect(config.clerkSecretKey).toBeUndefined();
  });

  it.each(Object.keys(PRODUCTION).filter((name) => !["NODE_ENV", "DATABASE_URL"].includes(name)))(
    "refuses to start without %s, naming it alone",
    (name) => {
      const env: Record<string, string> = { ...PRODUCTION };
      delete env[name];
      expect(problemsFor(env)).toEqual([`${name} is missing`]);
    },
  );

  it("treats a setting left empty in production as missing", () => {
    expect(problemsFor({ ...PRODUCTION, SIGNING_SECRET: "" })).toEqual([
      "SIGNING_SECRET is missing",
    ]);
  });

  it("names a missing production setting even when DATABASE_URL is missing too", () => {
    // A field missing outright used to stop zod before the production check, so this start
    // said only "DATABASE_URL is missing", and the next one "SIGNING_SECRET is missing".
    const env: Record<string, string> = { ...PRODUCTION };
    delete env["DATABASE_URL"];
    delete env["SIGNING_SECRET"];
    expect([...problemsFor(env)].sort()).toEqual([
      "DATABASE_URL is missing",
      "SIGNING_SECRET is missing",
    ]);
  });

  it("still checks the shape of a required setting that is there", () => {
    expect(
      problemsFor({ ...PRODUCTION, FALLBACK_VOICEMAIL_URL: "http://insecure.example.com" }),
    ).toEqual([expect.stringMatching(/^FALLBACK_VOICEMAIL_URL is invalid/)]);
  });
});

describe("Twilio", () => {
  it("needs both the SID and the token: one alone sets nothing up", () => {
    expect(loadConfig({ ...valid, TWILIO_ACCOUNT_SID: SID }).twilio).toBeUndefined();
    expect(loadConfig({ ...valid, TWILIO_AUTH_TOKEN: "t" }).twilio).toBeUndefined();
  });

  it("leaves purchases off unless the setting is exactly true", () => {
    const base = { ...valid, TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: "t" };
    expect(loadConfig(base).twilio?.purchasesEnabled).toBe(false);
    expect(
      loadConfig({ ...base, TWILIO_PURCHASES_ENABLED: "false" }).twilio?.purchasesEnabled,
    ).toBe(false);
    expect(loadConfig({ ...base, TWILIO_PURCHASES_ENABLED: "true" }).twilio?.purchasesEnabled).toBe(
      true,
    );
    // "TRUE", "1" and "yes" are refused, never read as on: buying numbers costs money.
    for (const value of ["TRUE", "1", "yes"]) {
      expect(problemsFor({ ...base, TWILIO_PURCHASES_ENABLED: value })[0]).toMatch(
        /^TWILIO_PURCHASES_ENABLED is invalid/,
      );
    }
  });

  it("turns purchases on for nothing when Twilio itself isn't set up", () => {
    expect(loadConfig({ ...valid, TWILIO_PURCHASES_ENABLED: "true" }).twilio).toBeUndefined();
  });

  it.each([
    ["TWILIO_ACCOUNT_SID", "AC" + "a".repeat(31)],
    ["TWILIO_ACCOUNT_SID", "AC" + "g".repeat(32)],
    ["TWILIO_ACCOUNT_SID", "SK" + "a".repeat(32)],
    ["TWILIO_BUNDLE_SID", "BU" + "b".repeat(33)],
    ["TWILIO_ADDRESS_SID", "AD" + "c".repeat(31)],
    ["TWILIO_ADDRESS_SID", "BU" + "c".repeat(32)],
  ])("refuses %s %s", (name, value) => {
    expect(problemsFor({ ...valid, [name]: value })[0]).toMatch(new RegExp(`^${name} is invalid`));
  });

  it("takes the SIDs in either case of hex", () => {
    const config = loadConfig({
      ...valid,
      TWILIO_ACCOUNT_SID: "AC" + "A".repeat(32),
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_ADDRESS_SID: "AD" + "F0".repeat(16),
    });
    expect(config.twilio).toMatchObject({ addressSid: "AD" + "F0".repeat(16) });
  });

  it("leaves the bundle and address out until they're set, so the purchase guard sees them missing", () => {
    const config = loadConfig({ ...valid, TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: "t" });
    expect(config.twilio).not.toHaveProperty("bundleSid");
    expect(config.twilio).not.toHaveProperty("addressSid");
  });
});

describe("the SMS sender", () => {
  it.each(["AnswerMate", "A", "Abcdefghijk", "Brock 24", "+447700900900", "+441134960000"])(
    "takes %s",
    (from) => {
      expect(
        loadConfig({
          ...valid,
          TWILIO_ACCOUNT_SID: SID,
          TWILIO_AUTH_TOKEN: "t",
          TWILIO_SMS_FROM: from,
        }).sms?.from,
      ).toBe(from);
    },
  );

  it.each(["Abcdefghijkl", "+0447700900900", "+44", "447700900900", " AnswerMate", "Answer-Mate"])(
    "refuses %s",
    (from) => {
      expect(problemsFor({ ...valid, TWILIO_SMS_FROM: from })[0]).toMatch(
        /^TWILIO_SMS_FROM is invalid/,
      );
    },
  );

  it("needs the Twilio credentials as well as the sender", () => {
    expect(loadConfig({ ...valid, TWILIO_SMS_FROM: "AnswerMate" }).sms).toBeUndefined();
    expect(
      loadConfig({ ...valid, TWILIO_SMS_FROM: "AnswerMate", TWILIO_ACCOUNT_SID: SID }).sms,
    ).toBeUndefined();
  });
});

describe("PUBLIC_BASE_URL and ALTERNATE_BASE_URL", () => {
  // Fixed alongside these tests: one slash was stripped, so "https://host//" kept the other and
  // every webhook URL built from it had "//" in it.
  it("strips every trailing slash, not just the last", () => {
    const config = loadConfig({
      ...valid,
      PUBLIC_BASE_URL: "https://callmate.example.com//",
      ALTERNATE_BASE_URL: "https://callmate-api.example.net///",
    });
    expect(config.publicBaseUrl).toBe("https://callmate.example.com");
    expect(config.alternateBaseUrl).toBe("https://callmate-api.example.net");
    expect(retellUrls(config).webhookUrl).toBe(
      "https://callmate.example.com/webhooks/voice/retell",
    );
  });

  it("keeps a path as given, stripping only the trailing slash", () => {
    expect(
      loadConfig({ ...valid, PUBLIC_BASE_URL: "https://example.com/answermate/" }).publicBaseUrl,
    ).toBe("https://example.com/answermate");
  });

  it("takes plain http (ngrok and local tunnels) but not other schemes", () => {
    expect(loadConfig({ ...valid, PUBLIC_BASE_URL: "http://localhost:3000" }).publicBaseUrl).toBe(
      "http://localhost:3000",
    );
    for (const url of ["ws://example.com", "callmate.example.com", "//callmate.example.com"]) {
      expect(problemsFor({ ...valid, PUBLIC_BASE_URL: url })[0]).toMatch(
        /^PUBLIC_BASE_URL is invalid/,
      );
    }
  });

  it("refuses the same host however it's written: another scheme, case or a path", () => {
    for (const alternate of [
      "http://callmate.example.com",
      "https://CALLMATE.example.com/other",
      "https://callmate.example.com:443",
    ]) {
      expect(
        problemsFor({
          ...valid,
          PUBLIC_BASE_URL: "https://callmate.example.com",
          ALTERNATE_BASE_URL: alternate,
        }),
        alternate,
      ).toEqual([
        "ALTERNATE_BASE_URL is invalid: must be a different address from PUBLIC_BASE_URL",
      ]);
    }
  });

  it("takes the same host on another port, which is another address", () => {
    expect(
      loadConfig({
        ...valid,
        PUBLIC_BASE_URL: "https://callmate.example.com",
        ALTERNATE_BASE_URL: "https://callmate.example.com:8443",
      }).alternateBaseUrl,
    ).toBe("https://callmate.example.com:8443");
  });

  it("takes an alternate address without a public one (nothing to compare it with)", () => {
    expect(
      loadConfig({ ...valid, ALTERNATE_BASE_URL: "https://callmate-api.example.net" })
        .alternateBaseUrl,
    ).toBe("https://callmate-api.example.net");
  });

  it("refuses the same address twice even when another setting fails at the type level", () => {
    expect(
      problemsFor({
        PUBLIC_BASE_URL: "https://callmate.example.com",
        ALTERNATE_BASE_URL: "https://callmate.example.com/other",
      }),
    ).toEqual([
      "DATABASE_URL is missing",
      "ALTERNATE_BASE_URL is invalid: must be a different address from PUBLIC_BASE_URL",
    ]);
  });

  it("names an address the schema refused once, not again as the same as the other", () => {
    // ws: parses as a URL with the same host, but the schema has already said it's wrong.
    expect(
      problemsFor({
        ...valid,
        PUBLIC_BASE_URL: "https://callmate.example.com",
        ALTERNATE_BASE_URL: "ws://callmate.example.com",
      }),
    ).toEqual([expect.stringMatching(/^ALTERNATE_BASE_URL is invalid(?!: must be a different)/)]);
  });
});

describe("DASHBOARD_ORIGIN", () => {
  // Fixed alongside these tests: any scheme was taken, and "localhost:5173" (no http://) parsed
  // with "localhost" as its scheme, giving the origin "null": every login refused, silently.
  it.each(["localhost:5173", "javascript:alert(1)", "file:///srv/dist", "ftp://example.com"])(
    "refuses %s, which has no web origin",
    (origin) => {
      expect(problemsFor({ ...valid, DASHBOARD_ORIGIN: origin })).toEqual([
        expect.stringMatching(/^DASHBOARD_ORIGIN is invalid/),
      ]);
    },
  );

  it("keeps the scheme, host and port, and drops the path, query and fragment", () => {
    expect(
      loadConfig({ ...valid, DASHBOARD_ORIGIN: "https://APP.example.com:8443/x/y?z=1#top" })
        .dashboardOrigin,
    ).toBe("https://app.example.com:8443");
    // The default port is no part of an origin.
    expect(
      loadConfig({ ...valid, DASHBOARD_ORIGIN: "https://app.example.com:443" }).dashboardOrigin,
    ).toBe("https://app.example.com");
  });
});

describe("email and alerts", () => {
  it.each(["EMAIL_FROM", "EMAIL_REPLY_TO", "ALERT_EMAIL"])("refuses a malformed %s", (name) => {
    for (const value of ["calls", "calls@", "@example.com", "calls example@example.com"]) {
      expect(problemsFor({ ...valid, [name]: value })[0], value).toMatch(
        new RegExp(`^${name} is invalid`),
      );
    }
  });

  it("leaves the reply-to out unless it's set", () => {
    expect(
      loadConfig({ ...valid, POSTMARK_SERVER_TOKEN: "t", EMAIL_FROM: "calls@example.com" }).email,
    ).toEqual({ serverToken: "t", from: "calls@example.com" });
  });

  it("needs the token as well as the From address", () => {
    expect(loadConfig({ ...valid, EMAIL_FROM: "calls@example.com" }).email).toBeUndefined();
  });

  it("takes an alert address without the email settings (the sender then says alerts are off)", () => {
    const config = loadConfig({ ...valid, ALERT_EMAIL: "alerts@example.com" });
    expect(config.alertEmail).toBe("alerts@example.com");
    expect(config.email).toBeUndefined();
  });
});

describe("secrets with a minimum length", () => {
  it.each([
    ["SIGNING_SECRET", 32],
    ["POSTMARK_WEBHOOK_SECRET", 16],
    ["GOCARDLESS_WEBHOOK_SECRET", 16],
  ])("%s takes %i characters and refuses one fewer", (name, length) => {
    expect(() => loadConfig({ ...valid, [name]: "s".repeat(length) })).not.toThrow();
    expect(problemsFor({ ...valid, [name]: "s".repeat(length - 1) })[0]).toMatch(
      new RegExp(`^${name} is invalid`),
    );
  });
});

describe("GoCardless", () => {
  it("ignores the environment and webhook secret without a token: billing stays off", () => {
    expect(
      loadConfig({
        ...valid,
        GOCARDLESS_ENVIRONMENT: "live",
        GOCARDLESS_WEBHOOK_SECRET: "w".repeat(16),
      }).payments,
    ).toBeUndefined();
  });

  it("refuses the environment in capitals rather than defaulting to the sandbox", () => {
    expect(problemsFor({ ...valid, GOCARDLESS_ENVIRONMENT: "LIVE" })[0]).toMatch(
      /^GOCARDLESS_ENVIRONMENT is invalid/,
    );
  });
});

describe("VAT", () => {
  it("takes a 12-digit branch VAT number as well as the usual 9", () => {
    expect(
      loadConfig({
        ...valid,
        VAT_REGISTRATION_NUMBER: "GB123456789012",
        VAT_REGISTRATION_FROM: "2027-04-01",
        VAT_SELLER_NAME: "Brockersby",
        VAT_SELLER_ADDRESS: "1 Example Street, Leeds, XQ1 2AB",
      }).vat,
    ).toEqual({ number: "GB123456789012", from: "2027-04-01" });
  });

  it.each(["GB12345678", "GB1234567890", "gb123456789", "123456789", "GB 123 4567 89"])(
    "refuses the VAT number %s",
    (number) => {
      expect(
        problemsFor({
          ...valid,
          VAT_REGISTRATION_NUMBER: number,
          VAT_REGISTRATION_FROM: "2027-04-01",
        })[0],
      ).toMatch(/^VAT_REGISTRATION_NUMBER is invalid/);
    },
  );

  it.each(["2027-13-01", "2027-02-30", "01/04/2027", "2027-04-01T00:00:00Z"])(
    "refuses the date %s",
    (from) => {
      expect(
        problemsFor({
          ...valid,
          VAT_REGISTRATION_NUMBER: "GB123456789",
          VAT_REGISTRATION_FROM: from,
        })[0],
      ).toMatch(/^VAT_REGISTRATION_FROM is invalid/);
    },
  );

  it("names the missing half even when another setting fails at the type level", () => {
    expect(
      [...problemsFor({ PORT: "port", VAT_REGISTRATION_NUMBER: "GB123456789" })].sort(),
    ).toEqual([
      "DATABASE_URL is missing",
      expect.stringMatching(/^PORT is invalid/),
      "VAT_REGISTRATION_FROM is missing",
      // And, as the number is there, what its invoices need.
      "VAT_SELLER_ADDRESS is missing",
      "VAT_SELLER_NAME is missing",
    ]);
  });
});

describe("Clerk", () => {
  it("turns \\n written on one line back into line breaks in the JWT key", () => {
    const oneLine = "-----BEGIN PUBLIC KEY-----\\nMIIBfake\\n-----END PUBLIC KEY-----";
    expect(loadConfig({ ...valid, CLERK_JWT_KEY: oneLine }).clerkJwtKey).toBe(
      "-----BEGIN PUBLIC KEY-----\nMIIBfake\n-----END PUBLIC KEY-----",
    );
  });

  it("refuses a JWT key that isn't a PEM public key", () => {
    for (const key of ["MIIBfake", "-----BEGIN PRIVATE KEY-----\\nx", "sk_test_fake"]) {
      expect(problemsFor({ ...valid, CLERK_JWT_KEY: key })[0], key).toMatch(
        /^CLERK_JWT_KEY is invalid/,
      );
    }
  });

  it("refuses a publishable key put where the secret key goes", () => {
    expect(problemsFor({ ...valid, CLERK_SECRET_KEY: "pk_live_fake" })[0]).toMatch(
      /^CLERK_SECRET_KEY is invalid/,
    );
  });
});

describe("the LLM", () => {
  it.each(["0", "1", "0.5", "0.001"])("takes the judge sample rate %s", (rate) => {
    expect(
      loadConfig({ ...valid, ANTHROPIC_API_KEY: "k", JUDGE_SAMPLE_RATE: rate }).llm
        ?.judgeSampleRate,
    ).toBe(Number(rate));
  });

  it.each(["-0.1", "1.01", "half", "50%"])("refuses the judge sample rate %s", (rate) => {
    expect(problemsFor({ ...valid, JUDGE_SAMPLE_RATE: rate })[0]).toMatch(
      /^JUDGE_SAMPLE_RATE is invalid/,
    );
  });

  it("treats an empty model as unset, so the pinned default applies", () => {
    expect(loadConfig({ ...valid, ANTHROPIC_API_KEY: "k", LLM_MODEL: "" }).llm?.model).toBe(
      "claude-haiku-5-5",
    );
  });
});

describe("the outbound allowlist", () => {
  it("is empty, so nothing is sent, when unset outside production", () => {
    expect(loadConfig(valid).outbound.allowlist.size).toBe(0);
  });
});

describe("ConfigError", () => {
  // Every setting given a bad value carrying a marker: no message may repeat it, because the
  // message goes to the log, and a mistyped secret is still a secret.
  it("never repeats a value, whichever setting is wrong", () => {
    const marker = "zzmarker";
    const names = [
      "NODE_ENV",
      "PORT",
      "LOG_LEVEL",
      "DATABASE_URL",
      "ADMIN_DATABASE_URL",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_PURCHASES_ENABLED",
      "TWILIO_BUNDLE_SID",
      "TWILIO_ADDRESS_SID",
      "PUBLIC_BASE_URL",
      "ALTERNATE_BASE_URL",
      "FALLBACK_VOICEMAIL_URL",
      "TWILIO_SMS_FROM",
      "EMAIL_FROM",
      "EMAIL_REPLY_TO",
      "ALERT_EMAIL",
      "GOCARDLESS_ENVIRONMENT",
      "GOCARDLESS_WEBHOOK_SECRET",
      "VAT_REGISTRATION_NUMBER",
      "VAT_REGISTRATION_FROM",
      "POSTMARK_WEBHOOK_SECRET",
      "SIGNING_SECRET",
      "CLERK_SECRET_KEY",
      "CLERK_JWT_KEY",
      "DASHBOARD_ORIGIN",
      "JUDGE_SAMPLE_RATE",
    ];
    // Shorter than every minimum length, and malformed for every pattern.
    const bad = `${marker} x!`;
    const env = Object.fromEntries(names.map((name) => [name, bad]));
    const problems = problemsFor(env);
    const error = new ConfigError(problems);
    expect(error.message).not.toContain(marker);
    for (const name of names) {
      expect(
        problems.some((problem) => problem.startsWith(`${name} `)),
        name,
      ).toBe(true);
    }
  });

  it("is an Error with its own name, and lists each problem on its own line", () => {
    const error = new ConfigError(["A is missing", "B is invalid: x"]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConfigError");
    expect(error.message).toBe(
      "Invalid environment configuration:\n  - A is missing\n  - B is invalid: x",
    );
  });
});

describe("retellUrls", () => {
  it("gives no URLs without a public address, and no key unless one is set", () => {
    expect(retellUrls({ publicBaseUrl: undefined, retellWebhookKey: undefined })).toEqual({});
  });

  it("gives both URLs under the public address, and the webhook key when set", () => {
    expect(
      retellUrls({ publicBaseUrl: "https://callmate.example.com", retellWebhookKey: "wk" }),
    ).toEqual({
      webhookKey: "wk",
      webhookUrl: "https://callmate.example.com/webhooks/voice/retell",
      functionUrl: "https://callmate.example.com/webhooks/voice/retell/function",
    });
  });
});
