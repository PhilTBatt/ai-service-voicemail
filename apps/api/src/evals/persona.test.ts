import { TRADES } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { REQUIRED_PERSONAS, loadPersonas, parsePersona } from "./persona.ts";

describe("personas", () => {
  const personas = loadPersonas();

  it("includes every persona BUILD_PLAN Step 7 lists, each with a unique id", () => {
    const ids = personas.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of REQUIRED_PERSONAS) expect(ids).toContain(required);
  });

  it("uses only fictional contact details: Ofcom drama numbers and a non-existent postcode area", () => {
    for (const p of personas) {
      if (p.caller.phone) expect(p.caller.phone.replaceAll(" ", "")).toMatch(/^07700900\d{3}$/);
      if (p.caller.postcode) expect(p.caller.postcode).toMatch(/^XQ\d/);
      if (p.expect.fields.callbackNumber) {
        expect(p.expect.fields.callbackNumber).toMatch(/^\+447700900\d{3}$/);
      }
    }
  });

  it("gives every emergency persona a verbatim script to check", () => {
    for (const id of ["gas-smell", "gas-in-passing", "co-alarm"]) {
      expect(personas.find((p) => p.id === id)?.expect.scripts).toEqual(["gas_emergency"]);
    }
    expect(personas.find((p) => p.id === "sparks-burning-smell")?.expect.scripts).toEqual([
      "danger",
    ]);
    expect(personas.find((p) => p.id === "water-through-ceiling")?.expect.scripts).toEqual([
      "water_leak",
    ]);
  });

  it("rejects a persona with an unknown script or a bad id", () => {
    expect(() =>
      parsePersona(
        `id: Bad Id\nname: x\ndescription: x\ncaller:\n  brief: x\nexpect:\n  scripts: [teleport]\n`,
        "bad.yaml",
      ),
    ).toThrow(/Invalid persona bad.yaml/);
  });

  it("fills in defaults", () => {
    const p = parsePersona(
      `id: min\nname: Minimal\ndescription: x\ncaller:\n  brief: x\nexpect: {}\n`,
      "min.yaml",
    );
    expect(p.variables).toEqual({ open_now: "yes", holiday_mode: "no" });
    expect(p.expect).toMatchObject({ scripts: [], ending: "any", maxTurns: 20, fields: {} });
    expect(p.caller.silent).toBe(false);
    expect(p.trade).toBe("plumber"); // the demo tenant's business
  });

  it("takes a trade and a list of endings, and rejects an unknown trade", () => {
    const p = parsePersona(
      `id: t\nname: T\ndescription: x\ntrade: roofer\ncaller:\n  brief: x\nexpect:\n  ending: [close, caller]\n`,
      "t.yaml",
    );
    expect(p.trade).toBe("roofer");
    expect(p.expect.ending).toEqual(["close", "caller"]);
    expect(() =>
      parsePersona(
        `id: t\nname: T\ndescription: x\ntrade: astronaut\ncaller:\n  brief: x\nexpect: {}\n`,
        "t.yaml",
      ),
    ).toThrow(/trade/);
  });

  it("rings a business of every trade somewhere in the set", () => {
    const trades = new Set(personas.map((p) => p.trade));
    expect([...trades].sort()).toEqual([...TRADES].sort());
  });

  it("tests the out-of-hours and holiday wording at least once each", () => {
    expect(personas.some((p) => p.variables.open_now === "no")).toBe(true);
    expect(personas.some((p) => p.variables.holiday_mode === "yes")).toBe(true);
  });
});
