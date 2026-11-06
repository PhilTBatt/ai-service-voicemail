import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const valid = { DATABASE_URL: "postgres://app:pw@localhost:5432/callmate" };

function configErrorFor(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw a ConfigError");
}

describe("loadConfig", () => {
  it("applies defaults when only the required variables are set", () => {
    expect(loadConfig(valid)).toEqual({
      nodeEnv: "development",
      port: 3000,
      logLevel: "info",
      databaseUrl: valid.DATABASE_URL,
      outbound: { nodeEnv: "development", allowlist: new Set() },
    });
  });

  it("parses explicit values, turning PORT into a number", () => {
    expect(
      loadConfig({
        ...valid,
        NODE_ENV: "production",
        RETELL_API_KEY: "key_for_tests",
        TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32),
        TWILIO_AUTH_TOKEN: "token_for_tests",
        PUBLIC_BASE_URL: "https://callmate.example.com",
        FALLBACK_VOICEMAIL_URL: "https://handler.twilio.com/twiml/EH0",
        ANTHROPIC_API_KEY: "key_for_tests",
        ADMIN_DATABASE_URL: "postgres://callmate_admin@localhost/callmate",
        TWILIO_SMS_FROM: "AnswerMate",
        PORT: "8080",
        LOG_LEVEL: "debug",
      }),
    ).toMatchObject({ nodeEnv: "production", port: 8080, logLevel: "debug" });
  });

  it("accepts the postgresql:// scheme", () => {
    const databaseUrl = "postgresql://app:pw@localhost:5432/callmate";
    expect(loadConfig({ DATABASE_URL: databaseUrl }).databaseUrl).toBe(databaseUrl);
  });

  it("names a missing required variable", () => {
    expect(configErrorFor({}).problems).toEqual(["DATABASE_URL is missing"]);
  });

  it("treats an empty value as missing, so defaults still apply", () => {
    expect(configErrorFor({ DATABASE_URL: "", PORT: "" }).problems).toEqual([
      "DATABASE_URL is missing",
    ]);
  });

  it.each([
    ["NODE_ENV", "staging"],
    ["PORT", "abc"],
    ["PORT", "70000"],
    ["PORT", "30.5"],
    ["LOG_LEVEL", "loud"],
    ["DATABASE_URL", "mysql://app:pw@localhost/callmate"],
    ["DATABASE_URL", "not a url"],
  ])("rejects an invalid %s (%s)", (name, value) => {
    const { problems } = configErrorFor({ ...valid, [name]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${name} is invalid`));
  });

  it("reports every problem at once", () => {
    const { problems } = configErrorFor({ PORT: "abc", LOG_LEVEL: "loud" });
    expect(problems.map((p) => p.split(" ")[0]).sort()).toEqual([
      "DATABASE_URL",
      "LOG_LEVEL",
      "PORT",
    ]);
  });

  it("never includes values in the error", () => {
    // A recognisable marker rather than a realistic-looking secret, so secret scanners
    // (GitGuardian watches this repo) don't flag the test itself.
    const marker = "value-that-must-never-appear";
    const error = configErrorFor({
      NODE_ENV: marker,
      PORT: marker,
      LOG_LEVEL: marker,
      DATABASE_URL: `mysql://app:${marker}@localhost/callmate`,
    });
    expect(error.message).not.toContain(marker);
    for (const name of ["NODE_ENV", "PORT", "LOG_LEVEL", "DATABASE_URL"]) {
      expect(error.message).toContain(name);
    }
  });

  it("ignores variables it doesn't know about", () => {
    expect(loadConfig({ ...valid, TWILIO_AUTH_TOKEN: "legacy" })).not.toHaveProperty(
      "TWILIO_AUTH_TOKEN",
    );
  });
});

describe("loadConfig: RETELL_API_KEY", () => {
  it("is optional outside production", () => {
    expect(loadConfig(valid).retellApiKey).toBeUndefined();
  });

  it("is required in production", () => {
    expect(configErrorFor({ ...valid, NODE_ENV: "production" }).problems).toContain(
      "RETELL_API_KEY is missing",
    );
  });

  it("is passed through when set", () => {
    expect(loadConfig({ ...valid, RETELL_API_KEY: "key_for_tests" }).retellApiKey).toBe(
      "key_for_tests",
    );
  });
});

describe("loadConfig: Twilio and PUBLIC_BASE_URL", () => {
  it("are optional outside production, with purchases off by default", () => {
    const config = loadConfig(valid);
    expect(config.twilio).toBeUndefined();
    expect(config.publicBaseUrl).toBeUndefined();
  });

  it("are required in production", () => {
    expect(
      configErrorFor({ ...valid, NODE_ENV: "production", RETELL_API_KEY: "k" }).problems,
    ).toEqual([
      "TWILIO_ACCOUNT_SID is missing",
      "TWILIO_AUTH_TOKEN is missing",
      "PUBLIC_BASE_URL is missing",
      "FALLBACK_VOICEMAIL_URL is missing",
      "ANTHROPIC_API_KEY is missing",
      "ADMIN_DATABASE_URL is missing",
      "TWILIO_SMS_FROM is missing",
    ]);
  });

  it("groups the Twilio settings and strips a trailing slash from the public URL", () => {
    const config = loadConfig({
      ...valid,
      TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32),
      TWILIO_AUTH_TOKEN: "token_for_tests",
      TWILIO_PURCHASES_ENABLED: "true",
      PUBLIC_BASE_URL: "https://callmate.example.com/",
    });
    expect(config.twilio).toEqual({
      accountSid: "AC" + "a".repeat(32),
      authToken: "token_for_tests",
      purchasesEnabled: true,
    });
    expect(config.publicBaseUrl).toBe("https://callmate.example.com");
  });

  it.each([
    ["TWILIO_ACCOUNT_SID", "not-a-sid"],
    ["TWILIO_PURCHASES_ENABLED", "yes"],
    ["PUBLIC_BASE_URL", "ftp://example.com"],
  ])("rejects an invalid %s", (name, value) => {
    expect(configErrorFor({ ...valid, [name]: value }).problems[0]).toMatch(
      new RegExp(`^${name} is invalid`),
    );
  });
});

describe("loadConfig: number purchasing", () => {
  it("passes the regulatory bundle and address through, and the voicemail bin URL", () => {
    const config = loadConfig({
      ...valid,
      TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32),
      TWILIO_AUTH_TOKEN: "token_for_tests",
      TWILIO_BUNDLE_SID: "BU" + "b".repeat(32),
      TWILIO_ADDRESS_SID: "AD" + "c".repeat(32),
      FALLBACK_VOICEMAIL_URL: "https://handler.twilio.com/twiml/EH0",
    });
    expect(config.twilio).toMatchObject({
      bundleSid: "BU" + "b".repeat(32),
      addressSid: "AD" + "c".repeat(32),
    });
    expect(config.fallbackVoicemailUrl).toBe("https://handler.twilio.com/twiml/EH0");
  });

  it("rejects a malformed bundle SID or a non-https voicemail URL", () => {
    expect(configErrorFor({ ...valid, TWILIO_BUNDLE_SID: "nope" }).problems[0]).toMatch(
      /^TWILIO_BUNDLE_SID is invalid/,
    );
    expect(
      configErrorFor({ ...valid, FALLBACK_VOICEMAIL_URL: "http://insecure" }).problems[0],
    ).toMatch(/^FALLBACK_VOICEMAIL_URL is invalid/);
  });
});

describe("loadConfig: LLM", () => {
  it("is off without a key, and pins the small model by default with one", () => {
    expect(loadConfig(valid).llm).toBeUndefined();
    expect(loadConfig({ ...valid, ANTHROPIC_API_KEY: "key_for_tests" }).llm).toEqual({
      apiKey: "key_for_tests",
      model: "claude-haiku-5-5",
    });
    expect(
      loadConfig({ ...valid, ANTHROPIC_API_KEY: "key_for_tests", LLM_MODEL: "claude-sonnet-5-5" })
        .llm?.model,
    ).toBe("claude-sonnet-5-5");
  });
});

describe("loadConfig: outbound messages", () => {
  it("parses the allowlist and leaves SMS off until a sender is set", () => {
    const config = loadConfig({ ...valid, OUTBOUND_ALLOWLIST: "+447700900001, phil@example.com" });
    expect(config.outbound).toEqual({
      nodeEnv: "development",
      allowlist: new Set(["+447700900001", "phil@example.com"]),
    });
    expect(config.sms).toBeUndefined();
  });

  it("configures SMS from the Twilio credentials plus the sender", () => {
    const config = loadConfig({
      ...valid,
      TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32),
      TWILIO_AUTH_TOKEN: "token_for_tests",
      TWILIO_SMS_FROM: "+447700900900",
    });
    expect(config.sms).toEqual({
      accountSid: "AC" + "a".repeat(32),
      authToken: "token_for_tests",
      from: "+447700900900",
    });
  });

  it.each(["0770090090", "ThisSenderIsTooLong", "1Alpha"])("rejects a bad sender %s", (from) => {
    expect(configErrorFor({ ...valid, TWILIO_SMS_FROM: from }).problems[0]).toMatch(
      /^TWILIO_SMS_FROM is invalid/,
    );
  });
});
