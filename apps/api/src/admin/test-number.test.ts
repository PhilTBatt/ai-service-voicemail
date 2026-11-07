import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assignPhoneNumber, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { PurchaseNotAllowedError } from "../providers/telephony.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { TEST_ADMIN_DATABASE_URL } from "../testing/databases.ts";
import { buyNumberForTenant, searchNumbers } from "./test-number.ts";

const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await admin.end();
});

const DEPS = {
  admin,
  publicBaseUrl: "https://callmate.example.com",
  fallbackVoicemailUrl: "https://handler.twilio.com/twiml/EHfake",
};

/** A tenant that already has a placeholder number, like the seed's demo tenant. */
async function makeTenant() {
  const tenantId = await createTenant(admin, { businessName: "Number Plumbing", trade: "plumber" });
  // Below 990: the 990 to 999 endings are reserved for "a number nobody owns" fixtures.
  const placeholder = `+441632960${String(Math.floor(Math.random() * 990)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [placeholder],
  );
  await assignPhoneNumber(admin, tenantId, placeholder, `PN${randomUUID()}`);
  return { tenantId, placeholder };
}

const numbersOf = async (tenantId: string) =>
  (
    await admin.query<{ number: string; status: string; provider_sid: string }>(
      "SELECT number, status, provider_sid FROM phone_numbers WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    )
  ).rows;

describe("searchNumbers", () => {
  it("asks the provider for up to ten matching numbers", async () => {
    const telephony = new FakeTelephonyProvider();
    const found = await searchNumbers(telephony, "0113");
    expect(found.length).toBeGreaterThan(0);
    for (const n of found) expect(n.number).toMatch(/^\+44113/);
  });
});

describe("buyNumberForTenant", () => {
  it("buys the number, points it at the API and the voicemail bin, and makes it the tenant's number", async () => {
    const { tenantId, placeholder } = await makeTenant();
    const telephony = new FakeTelephonyProvider();
    const [candidate] = await telephony.searchNumbers({ limit: 1 });
    // Each fake's stock overlaps; release any earlier test's copy of the same number.
    await admin.query(
      "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
      [candidate!.number],
    );

    const bought = await buyNumberForTenant(
      { telephony, ...DEPS },
      { tenantId, number: candidate!.number, confirm: true },
    );

    expect(telephony.purchased.get(bought.providerSid)?.config).toEqual({
      voiceUrl: "https://callmate.example.com/webhooks/twilio/voice",
      voiceFallbackUrl: "https://handler.twilio.com/twiml/EHfake",
      friendlyName: `CallMate ${tenantId}`,
    });
    expect(await numbersOf(tenantId)).toEqual([
      { number: placeholder, status: "released", provider_sid: expect.any(String) as unknown },
      { number: candidate!.number, status: "active", provider_sid: bought.providerSid },
    ]);
  });

  it("refuses without confirmation, buying nothing and changing nothing", async () => {
    const { tenantId, placeholder } = await makeTenant();
    const telephony = new FakeTelephonyProvider();
    await expect(
      buyNumberForTenant(
        { telephony, ...DEPS },
        { tenantId, number: "+441134960100", confirm: false },
      ),
    ).rejects.toThrow(PurchaseNotAllowedError);
    expect(telephony.purchased.size).toBe(0);
    expect(await numbersOf(tenantId)).toMatchObject([{ number: placeholder, status: "active" }]);
  });

  it("is still refused by the adapter when purchases are disabled in the environment", async () => {
    const { tenantId } = await makeTenant();
    const telephony = new FakeTelephonyProvider({ purchasesEnabled: false });
    await expect(
      buyNumberForTenant(
        { telephony, ...DEPS },
        { tenantId, number: "+441134960100", confirm: true },
      ),
    ).rejects.toThrow(PurchaseNotAllowedError);
  });
});
