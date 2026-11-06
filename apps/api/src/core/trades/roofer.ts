import type { TradeTemplate } from "./template.ts";

export const roofer: TradeTemplate = {
  trade: "roofer",
  description: "a roofing business",
  defaultServices: [
    "leak repairs",
    "tiles and slates",
    "flat roofs",
    "guttering, fascias and soffits",
    "chimney repairs",
    "full re-roofs",
  ],
  emergencyKeywords: [
    "water coming in",
    "leak",
    "tiles fallen",
    "storm damage",
    "ceiling bulging",
    "roof collapsed",
  ],
  questions: [
    "Is water coming into the property right now?",
    "Roughly how many storeys is the building, and is it a house or a flat?",
  ],
  defaultFaqs: [
    {
      question: "Can you give a quote over the phone?",
      answer:
        "No. The tradesperson looks at the roof first and will discuss it when they call back.",
    },
    {
      question: "Do you do insurance work?",
      answer:
        "The tradesperson will explain what they can do for an insurance claim when they call back.",
    },
  ],
};
