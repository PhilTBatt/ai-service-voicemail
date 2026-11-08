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
    // The platform goes straight to the close when this holds, so "wants to go" waits until
    // the agent has asked once for whatever's missing: the number and postcode matter most.
    closeWhen: `You have the caller's name, a confirmed call-back number, their postcode, the job and its urgency; or the caller wants to go and you've already asked once for anything that's missing (asking to be rung back isn't wanting to go); or the call isn't about ${profile.businessName} at all`,
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

/**
 * Keyed on the message, not the mention (decision 015): until it has been spoken, any mention so
 * far triggers it, so a mention the platform passes over (it's still on the opening, or another
 * message plays first) still gets its message on the next turn. Once spoken, it isn't repeated
 * for mere repeats: the eval run of 2026-11-07 heard the 999 message six times in a call whose
 * caller had said "nobody's hurt, no fire", and never got their number.
 */
const NOT_SPOKEN_YET = "and this message hasn't been spoken yet in the call";
const NOT_ON_REPEATS =
  "Not when it has been spoken and the caller is only repeating themselves or answering your questions.";

function buildScripts(profile: TenantProfile): FixedScript[] {
  const name = profile.tradespersonName;
  return [
    {
      id: "gas_emergency",
      // Over-trigger on purpose: a false alarm costs nothing. "Plays down" speaks the script
      // again when a caller dismisses it, instead of leaving the model to argue or paraphrase.
      trigger: `The caller has mentioned a smell of gas, a gas leak, carbon monoxide or a CO alarm, even in passing, ${NOT_SPOKEN_YET}. Again, once, if the caller plays this message down or the smell or alarm gets worse. If in doubt, trigger. ${NOT_ON_REPEATS}`,
      text: gasScript(name, profile.serviceRegion),
    },
    {
      id: "danger",
      trigger: `The caller has mentioned sparks, a burning smell, smoke, fire, an electric shock, exposed live wires, a ceiling or wall coming down, or anyone being in danger, ${NOT_SPOKEN_YET}. Again, once, if something new or worse happens: smoke or flames appear, or someone is hurt. If in doubt, trigger. ${NOT_ON_REPEATS}`,
      text: DANGER_SCRIPT,
    },
    {
      id: "water_leak",
      trigger: `The caller has said water is escaping and can't be stopped: a burst pipe, flooding, or water coming through a ceiling, ${NOT_SPOKEN_YET}. Not a dripping tap, a leaking toilet or a blocked drain.`,
      text: waterScript(name),
      // Saying it again tells a caller who can't find their stopcock nothing new.
      oncePerCall: true,
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
A caller who's in a hurry or upset still needs to give a call-back number and their postcode, because ${name} can't help without them: before the call ends, ask for whatever's missing in one short question. Asking to be rung back isn't the same as wanting to go.

## What ${business} does
Services:
${bullets(services)}
${areas}

## Opening hours (UK time)
${formatHours(profile.openingHours)}
If {{open_now}} is "no", tell the caller ${name} isn't working right now and that you'll take a message for them. Still take the full message. You can tell the caller the opening hours if they ask, but never say when ${name} will call back: not "first thing", not "when they're next open".
If {{holiday_mode}} is "yes", tell the caller ${name} is away${formatHolidayUntil(profile.holidayUntil)}, that you'll still take a message, and that it may take longer to get a call back.

## Urgency and safety
Treat these as urgent or an emergency: ${template.emergencyKeywords.join(", ")}.
${emergencies}
Safety messages are spoken by the system word for word when they're needed. Never repeat, paraphrase or add to one in your own words, and that includes reminders: don't tell the caller to ring anyone, or what to do, even in passing. If the caller dismisses a safety message, say only that you've noted it and that ${name} will be told.
If the caller asks what they should do to stay safe (whether to switch something off, unplug it, or leave), don't advise them: say you can't give safety advice, and that ${name} will be told straight away.
After a safety message, carry on taking the message, briefly: in an emergency the call-back number and postcode matter most.

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
