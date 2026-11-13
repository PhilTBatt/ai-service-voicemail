// Twilio's Usage Records API, over fetch like the other Twilio adapters.
//
// From Twilio's docs (https://www.twilio.com/docs/usage/api/usage-record, read 2026-11-13):
// GET /2010-04-01/Accounts/{AccountSid}/Usage/Records.json, with StartDate ("on or after") and
// EndDate ("on or before"), both YYYY-MM-DD "in GMT"; Category to pick one kind; PageSize up to
// 1000. The list is `usage_records`, each with `category`, `description`, `usage`,
// `usage_unit`, `price` and `price_unit` ("ISO 4217", lowercase). The schema calls `price` a
// number and its examples show a string, so both are accepted. "totalprice" is "the total
// price of all usage"; the docs say the parts may not add up to it.
//
// The account's balance isn't read: its endpoint isn't in the docs we could find.
import { z } from "zod";
import { poundsToPence } from "../core/prices.ts";
import type {
  DayRange,
  TwilioUsageLine,
  TwilioUsageProvider,
  TwilioUsageReading,
} from "./supplier-readings.ts";
import { TwilioApiError } from "./twilio.ts";

/**
 * The kinds of use shown, each a category from the docs' full list: what this service does
 * with Twilio. Everything else (if anything) is in the total and not listed.
 */
export const TWILIO_USAGE_CATEGORIES = [
  "calls-inbound-local",
  "calls-sip",
  "sms-outbound",
  "sms-inbound",
  "phonenumbers",
  "transcriptions",
] as const;

const TOTAL = "totalprice";

const amount = z.union([z.string(), z.number()]).nullable();

/** Pages followed at most: the records for 30 days fit in one, so more means something's wrong. */
const MAX_PAGES = 5;

const recordsSchema = z.object({
  next_page_uri: z.string().nullable().optional(),
  usage_records: z.array(
    z.object({
      category: z.string(),
      description: z.string().nullable(),
      usage: amount,
      usage_unit: z.string().nullable(),
      price: amount,
      price_unit: z.string().nullable(),
    }),
  ),
});

export interface TwilioUsageOptions {
  accountSid: string;
  authToken: string;
  /** For a price Twilio gives in dollars: the account is priced in pounds, so this is a fallback. */
  gbpPerUsd: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A provider's amount as a plain decimal string, never "1e-7". */
function decimal(value: string | number | null): string {
  if (value === null || value === "") return "0";
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Not a price: "${String(value)}"`);
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())
    ? value.trim()
    : number.toFixed(6);
}

/** Whole pence from a price in the unit Twilio gives it in. */
export function pricePence(
  price: string | number | null,
  unit: string | null,
  gbpPerUsd: string,
): number {
  const pounds = decimal(price);
  switch ((unit ?? "gbp").toLowerCase()) {
    case "gbp":
      return poundsToPence(pounds);
    case "usd": {
      // Whole cents, then pounds at the estimate's rate (held in ten-thousandths), rounded once.
      const cents = poundsToPence(pounds);
      const rate = Math.round(Number(gbpPerUsd) * 10_000);
      return Math.round((cents * rate) / 10_000);
    }
    default:
      throw new Error(`Twilio priced usage in ${unit ?? "nothing"}, not pounds or dollars`);
  }
}

export class TwilioUsageApi implements TwilioUsageProvider {
  private readonly options: TwilioUsageOptions;

  constructor(options: TwilioUsageOptions) {
    this.options = options;
  }

  async usage({ from, to }: DayRange): Promise<TwilioUsageReading> {
    const { accountSid, authToken, gbpPerUsd } = this.options;
    const path = `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Usage/Records.json`;
    const query = new URLSearchParams({ StartDate: from, EndDate: to, PageSize: "1000" });
    // One time limit for every page together.
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 8_000);
    const records: z.infer<typeof recordsSchema>["usage_records"] = [];
    // The docs give next_page_uri as a path on api.twilio.com, null on the last page.
    let next: string | null = `${path}?${query}`;
    for (let page = 0; next !== null; page += 1) {
      if (page === MAX_PAGES) throw new Error(`Twilio's usage records ran past ${MAX_PAGES} pages`);
      const response = await (this.options.fetch ?? fetch)(`https://api.twilio.com${next}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        },
        signal,
      });
      if (!response.ok) {
        throw new TwilioApiError(response.status, path, (await response.text()).slice(0, 300));
      }
      const parsed = recordsSchema.safeParse(await response.json());
      if (!parsed.success)
        throw new Error("Twilio's usage records weren't in the documented shape");
      records.push(...parsed.data.usage_records);
      next = parsed.data.next_page_uri ?? null;
    }
    const total = records.find((record) => record.category === TOTAL);
    const lines: TwilioUsageLine[] = [];
    for (const category of TWILIO_USAGE_CATEGORIES) {
      const record = records.find((each) => each.category === category);
      if (!record) continue;
      const pence = pricePence(record.price, record.price_unit, gbpPerUsd);
      const used = decimal(record.usage);
      if (pence === 0 && Number(used) === 0) continue;
      lines.push({
        category,
        description: record.description ?? category,
        pence,
        usage:
          `${Number(used).toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${record.usage_unit ?? ""}`.trim(),
      });
    }
    return {
      totalPence: total
        ? pricePence(total.price, total.price_unit, gbpPerUsd)
        : lines.reduce((sum, line) => sum + line.pence, 0),
      lines,
    };
  }
}
