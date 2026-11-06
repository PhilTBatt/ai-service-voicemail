import type { Trade } from "@callmate/shared";
import type { Faq } from "../profile.ts";

/** Trade defaults the prompt builder merges with a tenant's own profile. */
export interface TradeTemplate {
  trade: Trade;
  /** How the agent describes the business: "a plumbing business". */
  description: string;
  /** Used when the tenant hasn't listed their own services. */
  defaultServices: string[];
  /** Things a caller says that make the job urgent or an emergency. */
  emergencyKeywords: string[];
  /** Asked after the five essentials, when relevant. */
  questions: string[];
  /** Answers must defer to the tradesperson: no prices, no commitments. */
  defaultFaqs: Faq[];
}
