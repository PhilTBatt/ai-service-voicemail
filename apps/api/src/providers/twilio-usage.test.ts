// Twilio's usage records (twilio-usage.ts), against a stand-in for its API: the request asked,
// prices in the documented shapes, only the kinds we use, and every way it can go wrong.
import { describe, expect, it } from "vitest";
import { TwilioUsageApi, pricePence } from "./twilio-usage.ts";

const ACCOUNT_SID = "AC" + "0".repeat(32);

function stub(body: unknown, status = 200) {
  const requests: { url: string; auth: string | undefined; signal: boolean }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      signal: init?.signal instanceof AbortSignal,
    });
    return Promise.resolve(Response.json(body, { status }));
  };
  return { fetch: fetchStub, requests };
}

const record = (
  category: string,
  price: string | number | null,
  usage: string,
  unit = "minutes",
) => ({
  category,
  description: `About ${category}`,
  usage,
  usage_unit: unit,
  price,
  price_unit: "gbp",
  count: "1",
  count_unit: "calls",
});

const api = (fetchStub: typeof fetch) =>
  new TwilioUsageApi({
    accountSid: ACCOUNT_SID,
    authToken: "not-a-real-token",
    gbpPerUsd: "0.8",
    fetch: fetchStub,
  });

describe("TwilioUsageApi", () => {
  it("asks for the days given, both included, with the account's credentials", async () => {
    const twilio = stub({ usage_records: [] });
    await api(twilio.fetch).usage({ from: "2026-10-15", to: "2026-11-13" });
    expect(twilio.requests).toEqual([
      {
        url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Usage/Records.json?StartDate=2026-10-15&EndDate=2026-11-13&PageSize=1000`,
        auth: `Basic ${Buffer.from(`${ACCOUNT_SID}:not-a-real-token`).toString("base64")}`,
        signal: true,
      },
    ]);
  });

  it("gives Twilio's own total and the kinds we use, in pence, leaving out the rest and the empty", async () => {
    const twilio = stub({
      usage_records: [
        record("totalprice", "1.23456", "0", ""),
        record("calls-inbound-local", "0.07558", "10"),
        // The schema says a number, the examples a string: both are read.
        record("calls-sip", 0.04, "10"),
        record("sms-outbound", "0.42325", "10", "segments"),
        record("sms-inbound", "0", "0", "segments"),
        record("phonenumbers", "0.86917", "1", "numbers"),
        // A kind we don't use, and an aggregate that would count the calls twice.
        record("calls", "0.11558", "20"),
        record("conversations", "0.2", "3"),
      ],
    });
    expect(await api(twilio.fetch).usage({ from: "2026-10-15", to: "2026-11-13" })).toEqual({
      totalPence: 123,
      lines: [
        {
          category: "calls-inbound-local",
          description: "About calls-inbound-local",
          pence: 8,
          usage: "10 minutes",
        },
        { category: "calls-sip", description: "About calls-sip", pence: 4, usage: "10 minutes" },
        {
          category: "sms-outbound",
          description: "About sms-outbound",
          pence: 42,
          usage: "10 segments",
        },
        {
          category: "phonenumbers",
          description: "About phonenumbers",
          pence: 87,
          usage: "1 numbers",
        },
      ],
    });
  });

  it("adds up the kinds we use when there's no total in the answer", async () => {
    const twilio = stub({ usage_records: [record("calls-inbound-local", "0.5", "60")] });
    expect(
      (await api(twilio.fetch).usage({ from: "2026-10-15", to: "2026-11-13" })).totalPence,
    ).toBe(50);
  });

  it("throws with Twilio's status when it refuses", async () => {
    const twilio = stub({ code: 20003, message: "Authenticate" }, 401);
    await expect(
      api(twilio.fetch).usage({ from: "2026-10-15", to: "2026-11-13" }),
    ).rejects.toMatchObject({
      name: "TwilioApiError",
      status: 401,
    });
  });

  it("throws when the answer isn't the documented shape", async () => {
    const twilio = stub({ records: [] });
    await expect(api(twilio.fetch).usage({ from: "2026-10-15", to: "2026-11-13" })).rejects.toThrow(
      "Twilio's usage records weren't in the documented shape",
    );
  });

  it("gives up on a hung request at its time limit", async () => {
    const hung: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
      });
    const slow = new TwilioUsageApi({
      accountSid: ACCOUNT_SID,
      authToken: "not-a-real-token",
      gbpPerUsd: "0.8",
      fetch: hung,
      timeoutMs: 20,
    });
    await expect(slow.usage({ from: "2026-10-15", to: "2026-11-13" })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});

describe("TwilioUsageApi, over more than one page", () => {
  it("follows next_page_uri to the end, so a total on a later page is read", async () => {
    const urls: string[] = [];
    const pages: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      return Promise.resolve(
        Response.json(
          urls.length === 1
            ? {
                usage_records: [record("calls-inbound-local", "0.21", "28")],
                next_page_uri: `/2010-04-01/Accounts/${ACCOUNT_SID}/Usage/Records.json?Page=1&PageToken=PAx`,
              }
            : { usage_records: [record("totalprice", "1.51", "0", "")], next_page_uri: null },
        ),
      );
    };
    const reading = await api(pages).usage({ from: "2026-10-15", to: "2026-11-13" });
    expect(reading.totalPence).toBe(151);
    expect(reading.lines.map((line) => line.category)).toEqual(["calls-inbound-local"]);
    expect(urls[1]).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Usage/Records.json?Page=1&PageToken=PAx`,
    );
  });

  it("gives up after five pages rather than following forever", async () => {
    const endless: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          usage_records: [],
          next_page_uri: `/2010-04-01/Accounts/${ACCOUNT_SID}/Usage/Records.json?Page=9`,
        }),
      );
    await expect(api(endless).usage({ from: "2026-10-15", to: "2026-11-13" })).rejects.toThrow(
      "Twilio's usage records ran past 5 pages",
    );
  });
});

describe("pricePence", () => {
  it("rounds pounds to the nearest penny", () => {
    expect(pricePence("0.86917", "gbp", "0.8")).toBe(87);
    expect(pricePence("0.004", "GBP", "0.8")).toBe(0);
    expect(pricePence("0.005", "gbp", "0.8")).toBe(1);
    expect(pricePence(19.06, "gbp", "0.8")).toBe(1906);
  });

  it("reads tiny numbers as decimals, not as 1e-7", () => {
    expect(pricePence(0.0000001, "gbp", "0.8")).toBe(0);
  });

  it("treats nothing as nothing", () => {
    expect(pricePence(null, "gbp", "0.8")).toBe(0);
    expect(pricePence("", null, "0.8")).toBe(0);
  });

  it("turns dollars into pounds at the estimate's rate", () => {
    // $1.00 at 0.8 is 80p; $0.015 is 2 cents, 1.6p, so 2p.
    expect(pricePence("1.00", "usd", "0.8")).toBe(80);
    expect(pricePence("0.015", "usd", "0.8")).toBe(2);
  });

  it("refuses a currency it can't turn into pounds, and a negative price", () => {
    expect(() => pricePence("1", "eur", "0.8")).toThrow("Twilio priced usage in eur");
    expect(() => pricePence("-1", "gbp", "0.8")).toThrow("Not a price");
  });
});
