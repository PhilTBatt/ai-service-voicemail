// Turns a tenant's profile and their trade's template into an AgentDefinition. A pure
// function: the same profile always gives the same definition, which is what the snapshot
// tests check. Nothing here knows which voice platform is in use.
import type { AgentDefinition, FixedScript } from "./agent.ts";
import { WEEKDAYS, type OpeningHours, type TenantProfile } from "./profile.ts";
import {
  DANGER_SCRIPT,
  areYouAiLine,
  closingLine,
  gasScript,
  openingLine,
  waterScript,
} from "./scripts.ts";
import { getTradeTemplate, type TradeTemplate } from "./trades/index.ts";

/** Supplied by our server for each call (Step 4's inbound webhook). */
export const PER_CALL_VARIABLES = [
  { name: "open_now", description: '"yes" or "no": whether the business is open right now' },
  { name: "holiday_mode", description: '"yes" or "no": whether the tradesperson is away' },
  {
    name: "caller_number",
    description: 'the number the caller is ringing from, in UK format, or "unknown" if withheld',
  },
];

export function buildAgentDefinition(profile: TenantProfile): AgentDefinition {
  const template = getTradeTemplate(profile.trade);
  const names = { business: profile.businessName, tradesperson: profile.tradespersonName };
  return {
    tenantId: profile.tenantId,
    profileVersion: profile.profileVersion,
    language: "en-GB",
    timezone: "Europe/London",
    voice: { gender: "female" },
    opening: openingLine(names),
    instructions: buildInstructions(profile, template),
    scripts: buildScripts(profile),
    close: closingLine(profile.tradespersonName),
    perCallVariables: PER_CALL_VARIABLES,
    limits: {
      // Appendix B: 8 minutes with wrap-up from 6; demo calls capped at 3.
      maxCallSeconds: profile.isDemo ? 180 : 480,
      wrapUpAfterSeconds: profile.isDemo ? 120 : 360,
      silenceReminderSeconds: 5,
      endAfterSilenceSeconds: 10,
      beginMessageDelayMs: 1000,
    },
  };
}

function buildScripts(profile: TenantProfile): FixedScript[] {
  const name = profile.tradespersonName;
  return [
    {
      id: "gas_emergency",
      // Over-trigger on purpose: a false alarm costs nothing. "Plays down" re-fires the
      // script when a caller dismisses it, instead of leaving the model to paraphrase.
      trigger:
        "The caller mentions a smell of gas, a gas leak, carbon monoxide or a CO alarm, even in passing, or plays down a gas warning they've just been given. If in doubt, trigger.",
      text: gasScript(name, profile.serviceRegion),
    },
    {
      id: "danger",
      trigger:
        "The caller mentions sparks, a burning smell, smoke, fire, or anyone being in danger. If in doubt, trigger.",
      text: DANGER_SCRIPT,
    },
    {
      id: "water_leak",
      trigger:
        "Water is escaping and can't be stopped: a burst pipe, flooding, or water coming through a ceiling. Not a dripping tap, a leaking toilet or a blocked drain.",
      text: waterScript(name),
    },
    {
      id: "are_you_ai",
      trigger:
        "The caller asks whether they're talking to a robot, an AI, a machine or a real person.",
      text: areYouAiLine({ business: profile.businessName, tradesperson: name }),
    },
  ];
}

const DAY_NAMES: Record<keyof OpeningHours, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

function formatHours(hours: OpeningHours): string {
  return WEEKDAYS.map((day) => {
    const slot = hours[day];
    return `- ${DAY_NAMES[day]}: ${slot ? `${slot.open} to ${slot.close}` : "closed"}`;
  }).join("\n");
}

function formatHolidayUntil(isoDate: string | null): string {
  if (isoDate === null) return " until further notice";
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
  return ` until ${date}`;
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function buildInstructions(profile: TenantProfile, template: TradeTemplate): string {
  const { businessName: business, tradespersonName: name } = profile;
  const services = profile.services.length > 0 ? profile.services : template.defaultServices;
  const faqs = [...profile.faqs, ...template.defaultFaqs];
  const areas =
    profile.serviceAreas.length > 0
      ? `Areas covered:\n${bullets(profile.serviceAreas)}\nIf the caller is outside these areas, still take the message and say ${name} will confirm whether they can help.`
      : `Ask where the caller is. ${name} will confirm whether the area is covered.`;
  const emergencies = profile.emergencyPolicy.takesEmergencyCalls
    ? `${name} does take urgent call-outs, so make the urgency clear in the message.`
    : `${name} doesn't take emergency call-outs. If the job sounds urgent, say so honestly, take the message anyway, and don't promise a fast response.`;

  return `You are the AI phone assistant for ${business}, ${template.description} run by ${name}. Speak natural British English, keep replies short, and ask one question at a time.

## Your job
Take a message for ${name}. Always collect, in a natural order:
1. the caller's name
2. a call-back number. If {{caller_number}} is not "unknown", offer that first: ask whether the number they're calling from is the best one to ring them back on, and only take a different number if they want one. If it is "unknown", or they want a different number, take it and read it back to them digit by digit to confirm it
3. their postcode
4. what the job is
5. how urgent it is
Then, when relevant, ask:
${bullets(template.questions)}
When you have everything, or the caller wants to go, end the call. The system speaks the closing line.

## What ${business} does
Services:
${bullets(services)}
${areas}

## Opening hours (UK time)
${formatHours(profile.openingHours)}
If {{open_now}} is "no", tell the caller ${name} is closed right now, that you'll pass the message on, and that ${name} will call back when they're next open. Still take the full message.
If {{holiday_mode}} is "yes", tell the caller ${name} is away${formatHolidayUntil(profile.holidayUntil)}, that you'll still take a message, and that it may take longer to get a call back.

## Urgency and safety
Treat these as urgent or an emergency: ${template.emergencyKeywords.join(", ")}.
${emergencies}
Safety messages are spoken by the system word for word when they're needed. Never repeat, paraphrase or add to one in your own words. If the caller dismisses a safety message, say only that you've noted it and that ${name} will be told.

## Frequently asked questions
${faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n")}
If the caller asks something not covered here, say ${name} will answer when they call back.

## Rules you never break
- Never quote or estimate prices, even roughly, or say whether something is cheap or expensive. If asked, say ${name} will discuss cost when they call back.
- Never commit to times, dates, appointments or how soon ${name} will respond. If asked, say ${name} will discuss availability when they call back.
- Never give safety, legal or medical advice beyond the system's safety messages.
- Never claim to be human. If the caller asks whether you're an AI, the system answers for you; if it hasn't, say plainly that you are an AI assistant.
- Never discuss anything unrelated to ${business}.
- Never make up contact details or an address for ${name}. The caller will be called back.`;
}
