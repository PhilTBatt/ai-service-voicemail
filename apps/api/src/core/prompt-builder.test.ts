import { TRADES, givesSafetyAdvice, mentionsPrice, promisesTime } from "@callmate/shared";
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

    // The agent reads these out, and the post-call scan would flag every call that used one.
    it.each(TRADES)("%s: template wording has no prices, times or safety advice", (trade) => {
      const template = TRADE_TEMPLATES[trade];
      const spoken = [
        ...template.questions,
        ...template.defaultFaqs.flatMap((faq) => [faq.question, faq.answer]),
      ];
      for (const text of spoken) {
        expect(mentionsPrice(text), text).toBe(false);
        expect(promisesTime(text), text).toBe(false);
        expect(givesSafetyAdvice(text), text).toBe(false);
      }
    });

    it.each(TRADES)(
      "%s: speaks each safety message until it's been spoken, not on every mention",
      (trade) => {
        const { scripts } = buildAgentDefinition(sampleProfile({ trade }));
        const byId = (id: string) => scripts.find((s) => s.id === id);
        // Keyed on the message, not the first mention, so a mention passed over still triggers
        // it on the next turn (subagent review, 2026-11-08).
        for (const id of ["gas_emergency", "danger", "water_leak"]) {
          expect(byId(id)?.trigger).toContain("this message hasn't been spoken yet in the call");
          expect(byId(id)?.trigger).not.toContain("first time");
        }
        for (const id of ["gas_emergency", "danger"]) {
          expect(byId(id)?.trigger).toContain("If in doubt, trigger.");
          expect(byId(id)?.trigger).toContain("Again, once, if");
          expect(byId(id)?.trigger).toContain("Not when it has been spoken");
          // Played down or worse: spoken again, so these two may repeat.
          expect(byId(id)?.oncePerCall).toBeUndefined();
        }
        expect(byId("gas_emergency")?.trigger).toContain("plays this message down");
        // The water message says nothing new the second time.
        expect(byId("water_leak")?.oncePerCall).toBe(true);
      },
    );
  });

  it("gives the platform and the simulation one close condition, which a call-back request doesn't meet", () => {
    const { closeWhen } = buildAgentDefinition(sampleProfile());
    expect(closeWhen).toContain("a confirmed call-back number, their postcode");
    // The platform closes as soon as this holds, so a caller in a hurry is asked once first.
    expect(closeWhen).toContain("you've already asked once for anything that's missing");
    expect(closeWhen).toContain("asking to be rung back isn't wanting to go");
    expect(closeWhen).toContain("isn't about Ant's Plumbing at all");
  });

  it("never says when the tradesperson will call back out of hours", () => {
    const { instructions } = buildAgentDefinition(sampleProfile());
    expect(instructions).toContain("never say when Ant will call back");
    expect(instructions).not.toContain("call back when they're next open");
  });

  it("tells the agent to decline safety questions and still get the number and postcode", () => {
    const { instructions } = buildAgentDefinition(sampleProfile());
    expect(instructions).toContain("don't advise them: say you can't give safety advice");
    expect(instructions).toContain("ask for whatever's missing in one short question");
    // "Please do ring the gas emergency number now" (eval run of 2026-11-08) is a paraphrase too.
    expect(instructions).toContain("don't tell the caller to ring anyone, or what to do");
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
      "holiday_until",
      "caller_number",
    ]);
    expect(definition.instructions).toContain('If {{open_now}} is "no"');
    expect(definition.instructions).toContain('If {{holiday_mode}} is "yes"');
    // The date goes with each call (core/availability.ts), so a HOLIDAY text changes it at once.
    expect(definition.instructions).toContain("Ant is away {{holiday_until}}");
    expect(definition.instructions).not.toContain("24 December");
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

// Overnight hours (2026-11-13): the prompt says which morning a late slot closes, so the model
// reads 18:00 to 02:00 as meant, and a caller at 01:00 on Saturday as inside Friday's hours.
describe("opening hours that run overnight", () => {
  it("says which morning an overnight slot closes, and leaves a same-day slot as it was", () => {
    const { instructions } = buildAgentDefinition(
      sampleProfile({
        openingHours: {
          mon: { open: "08:00", close: "18:00" },
          fri: { open: "18:00", close: "02:00" },
          sun: { open: "20:00", close: "06:00" },
        },
      }),
    );
    expect(instructions).toContain("- Monday: 08:00 to 18:00\n");
    expect(instructions).toContain("- Friday: 18:00 to 02:00 (into Saturday morning)\n");
    expect(instructions).toContain("- Saturday: closed\n");
    // The week wraps: Sunday night closes on Monday morning.
    expect(instructions).toContain("- Sunday: 20:00 to 06:00 (into Monday morning)\n");
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
      'If {{caller_number}} is not "unknown", don\'t ask for a number: offer theirs, saying it',
    );
    expect(definition.instructions).toContain("read it back to them digit by digit");
    // Names and postcodes are read back to the caller; nothing else is (Phil, 2026-11-10).
    expect(definition.instructions).toContain("read each back once as soon as you have it");
    expect(definition.instructions).toContain("Don't read back the job or anything else.");
    // The eval run of 2026-11-11: a burning-smell call ran past its turn limit on a read-back
    // asked as its own question ("Thanks, is that Nadia?"), then a question about the job asked
    // after the name, number and postcode were in. A name is read back with the next question,
    // the trade's questions come while the job is being described, and then the call ends.
    expect(definition.instructions).toContain(
      "Read a name back in the same breath as your next question, not as a question of its own",
    );
    expect(definition.instructions).toContain("Read a postcode back as its own question");
    expect(definition.instructions).toContain(
      "While the caller is telling you about the job, ask whichever of these they haven't already answered",
    );
    // The next run (gas-in-passing): it still asked two of them, and how urgent a gas smell was,
    // after the postcode. They're optional, and urgency is asked only when it isn't clear.
    expect(definition.instructions).toContain(
      "never ask one once you have the call-back number and postcode",
    );
    expect(definition.instructions).toContain(
      "how urgent it is, unless that's already clear from what they've said",
    );
    expect(definition.instructions).toContain(
      "When you have the five things above, end the call without starting a new question",
    );
    expect(definition.perCallVariables.map((v) => v.name)).toEqual([
      "open_now",
      "holiday_mode",
      "holiday_until",
      "caller_number",
    ]);
  });
});
