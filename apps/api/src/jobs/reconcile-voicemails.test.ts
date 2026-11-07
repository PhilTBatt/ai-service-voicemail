import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assignPhoneNumber, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { storeFallbackVoicemail } from "../db/voicemails.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { reconcileVoicemails } from "./reconcile-voicemails.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const NOW = new Date("2026-11-06T20:00:00Z");

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

async function makeTenant() {
  const tenantId = await createTenant(admin, {
    businessName: "Reconcile Locks",
    trade: "locksmith",
  });
  const number = `+441214960${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  return { tenantId, number };
}

/** A recording at the "provider" for a call to `to`, with its call details. */
function addRecording(telephony: FakeTelephonyProvider, to: string, minutesAgo: number) {
  const callSid = `CA${randomUUID().replace(/-/g, "")}`;
  const createdAt = new Date(NOW.getTime() - minutesAgo * 60_000);
  telephony.recordings.push({
    recordingSid: `RE${randomUUID().replace(/-/g, "")}`,
    callSid,
    url: `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE_${callSid}`,
    durationSeconds: 30,
    createdAt,
  });
  telephony.callDetails.set(callSid, {
    callSid,
    from: "+447700900123",
    to,
    startedAt: new Date(createdAt.getTime() - 60_000),
    endedAt: createdAt,
    durationSeconds: 60,
  });
  return callSid;
}

const callRows = (tenantId: string) =>
  withTenant(app, tenantId, async (client) => {
    const { rows } = await client.query<{ provider_call_id: string }>(
      "SELECT provider_call_id FROM calls WHERE via_fallback ORDER BY started_at",
    );
    return rows.map((r) => r.provider_call_id);
  });

describe("reconcileVoicemails", () => {
  it("stores recordings that have no call row, skips ones already stored, and never stores twice", async () => {
    const { tenantId, number } = await makeTenant();
    const telephony = new FakeTelephonyProvider();
    const missed = addRecording(telephony, number, 30);
    const alreadyStored = addRecording(telephony, number, 45);
    const details = telephony.callDetails.get(alreadyStored)!;
    await storeFallbackVoicemail(app, {
      callSid: alreadyStored,
      from: details.from,
      to: details.to,
      recordingUrl: "https://api.twilio.com/x",
      durationSeconds: 30,
      startedAt: details.startedAt,
      endedAt: details.endedAt,
    });

    const enqueueNotifications = vi.fn(() => Promise.resolve());
    expect(
      await reconcileVoicemails({ pool: app, telephony, enqueueNotifications, now: () => NOW }),
    ).toEqual({
      checked: 2,
      stored: 1,
      duplicate: 1,
      unknownNumber: 0,
      noCallDetails: 0,
    });
    expect(await callRows(tenantId)).toEqual([alreadyStored, missed]);
    // One text: for the voicemail that was missing, not the one already stored.
    expect(enqueueNotifications).toHaveBeenCalledTimes(1);

    // A second run finds nothing new.
    expect(await reconcileVoicemails({ pool: app, telephony, now: () => NOW })).toMatchObject({
      stored: 0,
      duplicate: 2,
    });
    expect(await callRows(tenantId)).toHaveLength(2);
  });

  it("only looks back over the configured window", async () => {
    const { tenantId, number } = await makeTenant();
    const telephony = new FakeTelephonyProvider();
    addRecording(telephony, number, 25 * 60); // 25 hours ago
    expect(
      await reconcileVoicemails({ pool: app, telephony, now: () => NOW, lookbackHours: 24 }),
    ).toMatchObject({
      checked: 0,
    });
    expect(await callRows(tenantId)).toEqual([]);
  });

  it("counts recordings for numbers nobody owns, and calls the provider no longer knows, without failing", async () => {
    const telephony = new FakeTelephonyProvider();
    addRecording(telephony, "+441632960999", 10);
    const orphan = addRecording(telephony, "+441632960998", 10);
    telephony.callDetails.delete(orphan);
    expect(await reconcileVoicemails({ pool: app, telephony, now: () => NOW })).toEqual({
      checked: 2,
      stored: 0,
      duplicate: 0,
      unknownNumber: 1,
      noCallDetails: 1,
    });
  });
});
