import type { Trade } from "@callmate/shared";
import { electrician } from "./electrician.ts";
import { generalBuilder } from "./general-builder.ts";
import { heatingEngineer } from "./heating-engineer.ts";
import { locksmith } from "./locksmith.ts";
import { plumber } from "./plumber.ts";
import { roofer } from "./roofer.ts";
import type { TradeTemplate } from "./template.ts";

export type { TradeTemplate } from "./template.ts";

export const TRADE_TEMPLATES: Record<Trade, TradeTemplate> = {
  plumber,
  electrician,
  heating_engineer: heatingEngineer,
  roofer,
  locksmith,
  general_builder: generalBuilder,
};

export function getTradeTemplate(trade: Trade): TradeTemplate {
  return TRADE_TEMPLATES[trade];
}
