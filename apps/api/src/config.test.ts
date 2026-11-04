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
    });
  });

  it("parses explicit values, turning PORT into a number", () => {
    expect(
      loadConfig({ ...valid, NODE_ENV: "production", PORT: "8080", LOG_LEVEL: "debug" }),
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
    const secret = "s3cr3t-do-not-print";
    const error = configErrorFor({
      NODE_ENV: secret,
      PORT: secret,
      LOG_LEVEL: secret,
      DATABASE_URL: `mysql://app:${secret}@localhost/callmate`,
    });
    expect(error.message).not.toContain(secret);
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
