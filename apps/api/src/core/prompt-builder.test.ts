import { TRADES } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { sampleProfile } from "../testing/profile-fixture.ts";
import { tenantProfileSchema } from "./profile.ts";
import { buildAgentDefinition } from "./prompt-builder.ts";
import { TRADE_TEMPLATES } from "./trades/index.ts";

const script = (profile: Parameters<typeof buildAgentDefinition>[0], id: string) =>
  buildAgentDefinition(profile).scripts.find((s) => s.id === id)?.text ?? "";

describe("buildAgentDefinition", () => {
  // The snapshots are the full prompt for each trade. A change to any wording shows up as
  // a diff to review, and Phil approves the Appendix A wording before go-live.
  it.each(TRADES)("produces the same definition every time for a %s", (trade) => {
    expect(buildAgentDefinition(sampleProfile({ trade }))).toMatchSnapshot();
  });

  describe("every trade", () => {
    it.each(TRADES)("%s: opens with the AI and recording disclosure, then a question", (trade) => {
      const { opening } = buildAgentDefinition(sampleProfile({ trade }));
      expect(opening).toContain("I'm their AI assistant. This call is recorded and transcribed");
      expect(opening).toMatch(/\?$/);
    });

    it.each(TRADES)("%s: has all four fixed scripts, with the gas number given twice", (trade) => {
      const { scripts } = buildAgentDefinition(sampleProfile({ trade }));
      expect(scripts.map((s) => s.id)).toEqual([
        "gas_emergency",
        "danger",
        "water_leak",
        "are_you_ai",
      ]);
      expect(script(sampleProfile({ trade }), "gas_emergency").match(/0800 111 999/g)).toHaveLength(
        2,
      );
      expect(script(sampleProfile({ trade }), "danger")).toContain("call 999");
      expect(script(sampleProfile({ trade }), "are_you_ai")).toMatch(/^Yes, I'm an AI assistant/);
    });

    it.each(TRADES)(
      "%s: tells the model to collect the five essentials and read the number back",
      (trade) => {
        const { instructions } = buildAgentDefinition(sampleProfile({ trade }));
        for (const item of [
          "caller's name",
          "call-back number",
          "postcode",
          "what the job is",
          "how urgent",
        ]) {
          expect(instructions).toContain(item);
        }
        expect(instructions).toContain("read it back to them digit by digit");
      },
    );

    it.each(TRADES)("%s: carries the price, commitment and not-human rules", (trade) => {
      const { instructions } = buildAgentDefinition(sampleProfile({ trade }));
      expect(instructions).toContain("Never quote or estimate prices");
      expect(instructions).toContain("Never commit to times, dates, appointments");
      expect(instructions).toContain("Never claim to be human");
      expect(instructions).toContain("Never repeat, paraphrase or add to one in your own words");
    });

    it.each(TRADES)("%s: includes the template's questions, keywords and FAQs", (trade) => {
      const { instructions } = buildAgentDefinition(sampleProfile({ trade, faqs: [] }));
      const template = TRADE_TEMPLATES[trade];
      for (const question of template.questions) expect(instructions).toContain(question);
      for (const keyword of template.emergencyKeywords) expect(instructions).toContain(keyword);
      for (const faq of template.defaultFaqs) expect(instructions).toContain(faq.answer);
    });
  });

  it("uses the Northern Ireland gas number for NI tenants", () => {
    const gas = script(sampleProfile({ serviceRegion: "NI" }), "gas_emergency");
    expect(gas.match(/0800 002 001/g)).toHaveLength(2);
    expect(gas).not.toContain("0800 111 999");
  });

  it("caps demo calls at 3 minutes and live calls at 8, with wrap-up from 6", () => {
    expect(buildAgentDefinition(sampleProfile({ isDemo: true })).limits).toMatchObject({
      maxCallSeconds: 180,
      wrapUpAfterSeconds: 120,
    });
    expect(buildAgentDefinition(sampleProfile({ isDemo: false })).limits).toMatchObject({
      maxCallSeconds: 480,
      wrapUpAfterSeconds: 360,
    });
  });

  it("writes the opening hours out, with closed days", () => {
    const { instructions } = buildAgentDefinition(sampleProfile());
    expect(instructions).toContain("- Friday: 08:00 to 17:00");
    expect(instructions).toContain("- Saturday: 09:00 to 13:00");
    expect(instructions).toContain("- Sunday: closed");
  });

  it("refers to the per-call open and holiday variables in the wording", () => {
    const definition = buildAgentDefinition(sampleProfile({ holidayUntil: "2026-12-24" }));
    expect(definition.perCallVariables.map((v) => v.name)).toEqual([
      "open_now",
      "holiday_mode",
      "caller_number",
    ]);
    expect(definition.instructions).toContain('If {{open_now}} is "no"');
    expect(definition.instructions).toContain('If {{holiday_mode}} is "yes"');
    expect(definition.instructions).toContain("Ant is away until 24 December 2026");
    expect(buildAgentDefinition(sampleProfile({ holidayUntil: null })).instructions).toContain(
      "Ant is away until further notice",
    );
  });

  it("falls back to the template's services when the tenant lists none", () => {
    const { instructions } = buildAgentDefinition(
      sampleProfile({ services: [], serviceAreas: [] }),
    );
    expect(instructions).toContain("- leaks and burst pipes");
    expect(instructions).toContain("Ask where the caller is.");
  });

  it("changes the wording when the tradesperson doesn't take emergency call-outs", () => {
    const { instructions } = buildAgentDefinition(
      sampleProfile({ emergencyPolicy: { takesEmergencyCalls: false } }),
    );
    expect(instructions).toContain("doesn't take emergency call-outs");
    expect(instructions).toContain("don't promise a fast response");
  });

  it("never puts the gas or 999 wording into the free-text instructions", () => {
    // Scripts are spoken by fixed nodes; the model must not have them to paraphrase.
    const { instructions } = buildAgentDefinition(sampleProfile());
    expect(instructions).not.toContain("0800 111 999");
    expect(instructions).not.toContain("call 999");
  });
});

describe("tenantProfileSchema", () => {
  it("accepts the sample profile", () => {
    expect(tenantProfileSchema.safeParse(sampleProfile()).success).toBe(true);
  });

  it.each([
    ["a bad time", { openingHours: { mon: { open: "8am", close: "18:00" } } }],
    ["an unknown trade", { trade: "plasterer" }],
    ["an empty tradesperson name", { tradespersonName: "" }],
    ["a bad holiday date", { holidayUntil: "24/12/2026" }],
  ])("rejects %s", (_label, bad) => {
    expect(tenantProfileSchema.safeParse({ ...sampleProfile(), ...bad }).success).toBe(false);
  });
});

describe("call-back number instructions", () => {
  it("tells the agent to offer the number the caller is ringing from before asking for one", () => {
    const definition = buildAgentDefinition(sampleProfile());
    expect(definition.instructions).toContain(
      'If {{caller_number}} is not "unknown", offer that first',
    );
    expect(definition.instructions).toContain("read it back to them digit by digit");
    expect(definition.perCallVariables.map((v) => v.name)).toEqual([
      "open_now",
      "holiday_mode",
      "caller_number",
    ]);
  });
});
