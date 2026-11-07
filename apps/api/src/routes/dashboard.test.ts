import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { createApp } from "../app.ts";
import type { AgentProfileInput } from "../db/agent-profiles.ts";
import { addMembership, createAdminPool, createTenant, createUser } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { FakeAuthProvider } from "../providers/auth.fake.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { startQueue } from "../jobs/queue.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const auth = new FakeAuthProvider();
const voice = new FakeVoiceProvider();
const telephony = new FakeTelephonyProvider();

let boss: PgBoss;
let get: (path: string, token?: string) => Promise<Response>;
let send: (method: "PUT", path: string, body: unknown, token?: string) => Promise<Response>;
let stop: () => Promise<void>;

/** Two tenants, one call each, and a person in every role: the fixture for every test. */
let tenantA: string;
let tenantB: string;
let callA: string;
let callB: string;
type Who = "ownerA" | "ownerB" | "admin" | "reseller" | "stranger";
const tokens = {} as Record<Who, string>;

interface CallSummary {
  callId: string;
  summary: string | null;
  [key: string]: unknown;
}
interface CallList {
  calls: CallSummary[];
  nextBefore: string | null;
}
interface TenantList {
  tenants: { id: string; [key: string]: unknown }[];
}
const json = async <T>(response: Promise<Response>): Promise<T> =>
  (await response).json() as Promise<T>;
const summaries = (list: CallList) => list.calls.map((call) => call.summary);

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
  const server = createApp({
    pool: app,
    dashboard: { admin, auth, boss, voice, telephony },
  }).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  get = (path, token) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  send = (method, path, body, token) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  stop = () => new Promise((resolve) => server.close(() => resolve()));

  tenantA = await createTenant(admin, {
    businessName: "Dash Plumbing",
    trade: "plumber",
    contactName: "Sam",
    notificationMobile: "+447700900701",
  });
  tenantB = await createTenant(admin, { businessName: "Other Sparks", trade: "electrician" });
  callA = await insertCall(tenantA, "Boiler leaking.", "urgent");
  callB = await insertCall(tenantB, "Fuse box tripping.", "routine");

  const person = async (role: "owner" | "admin" | "reseller", tenantIds: string[] = []) => {
    const subject = `sub_${randomUUID()}`;
    const email = `${role}-${randomUUID()}@example.com`;
    const userId = await createUser(admin, { authSubject: subject, email, role });
    for (const tenantId of tenantIds) await addMembership(admin, tenantId, userId);
    return auth.tokenFor({ subject, email });
  };
  tokens.ownerA = await person("owner", [tenantA]);
  tokens.ownerB = await person("owner", [tenantB]);
  tokens.admin = await person("admin");
  tokens.reseller = await person("reseller");
  // Logged in with the provider, but never invited: no users row.
  tokens.stranger = auth.tokenFor({ subject: `sub_${randomUUID()}`, email: "nobody@example.com" });
});

afterAll(async () => {
  await stop();
  await boss.stop({ graceful: false, close: true });
  await Promise.all([app.end(), admin.end()]);
});

async function insertCall(tenantId: string, summary: string, urgency: string, startedAt?: string) {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at, billable_seconds,
                        transcript, summary, urgency, flags, extracted_fields, recording_ref)
     VALUES ($1, $2, '+447700900123', $5, $5::timestamptz + interval '2 minutes', 120,
             E'agent: Hi, how can I help?\\ncaller: Something is wrong.', $3, $4, '{}',
             '{"callerName":"Sam","callbackNumber":"+447700900123","postcode":"XQ12 3JL"}', 'rec')
     RETURNING id`,
    [tenantId, `call_${randomUUID()}`, summary, urgency, startedAt ?? "2026-11-07T09:00:00Z"],
  );
  return rows[0]!.id;
}

describe("authentication", () => {
  it("wants a bearer token, and one the provider recognises", async () => {
    expect((await get("/me")).status).toBe(401);
    expect((await get("/me", "not-a-real-token")).status).toBe(401);
    const revoked = auth.tokenFor({ subject: "sub_gone", email: "gone@example.com" });
    auth.revoke(revoked);
    expect((await get("/me", revoked)).status).toBe(401);
  });

  it("turns away someone who is logged in but has no account here", async () => {
    const response = await get("/me", tokens.stranger);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "No account for this login" });
  });

  it("tells a person who they are to us", async () => {
    const me = await json<{ role: string; tenantIds: string[]; email: string }>(
      get("/me", tokens.ownerA),
    );
    expect(me).toMatchObject({ role: "owner", tenantIds: [tenantA] });
    expect(me.email).toMatch(/^owner-.*@example\.com$/);
    expect((await json<{ role: string }>(get("/me", tokens.reseller))).role).toBe("reseller");
  });

  it("never caches an answer", async () => {
    expect((await get("/me", tokens.admin)).headers.get("cache-control")).toBe("no-store");
  });
});

describe("authorisation matrix", () => {
  // Every role against every endpoint (BUILD_PLAN Step 10). A new endpoint must add a row.
  // Writes carry bodies that change nothing: an invalid profile (400) and a switch on a
  // tenant that is still onboarding (409).
  const endpoints = (): { name: string; path: string; body?: unknown }[] => [
    { name: "GET /me", path: "/me" },
    { name: "GET /tenants", path: "/tenants" },
    { name: "GET /tenants/:id", path: `/tenants/${tenantA}` },
    { name: "GET /tenants/:id/calls", path: `/tenants/${tenantA}/calls` },
    { name: "GET /tenants/:id/calls/:callId", path: `/tenants/${tenantA}/calls/${callA}` },
    {
      name: "GET /tenants/:id/calls/:callId/recording",
      path: `/tenants/${tenantA}/calls/${callA}/recording`,
    },
    { name: "GET /tenants/:id/profile", path: `/tenants/${tenantA}/profile` },
    { name: "PUT /tenants/:id/profile", path: `/tenants/${tenantA}/profile`, body: {} },
    { name: "PUT /tenants/:id/switch", path: `/tenants/${tenantA}/switch`, body: { on: true } },
  ];
  // What tenant A's data looks like to each person. "allowed" means the door opened: the
  // request may still 400, 404 or 409 on its merits (no audio at the fake, invalid body).
  type Verdict = "allowed" | 403;
  const expected: Record<Who, { default: Verdict } & Partial<Record<string, Verdict>>> = {
    ownerA: { default: "allowed" },
    ownerB: { "GET /me": "allowed", "GET /tenants": "allowed", default: 403 },
    admin: { default: "allowed" },
    reseller: { "GET /me": "allowed", "GET /tenants": "allowed", default: 403 },
    stranger: { default: 403 },
  };

  for (const who of Object.keys(expected) as Who[]) {
    it(`${who} gets the right doors`, async () => {
      for (const endpoint of endpoints()) {
        const want = expected[who][endpoint.name] ?? expected[who].default;
        const { status } =
          endpoint.body === undefined
            ? await get(endpoint.path, tokens[who])
            : await send("PUT", endpoint.path, endpoint.body, tokens[who]);
        if (want === "allowed") {
          expect([200, 400, 404, 409], `${who} ${endpoint.name} → ${status}`).toContain(status);
        } else {
          expect(status, `${who} ${endpoint.name}`).toBe(want);
        }
      }
    });
  }

  it("reseller cannot get call content", async () => {
    // The named test BUILD_PLAN Step 10 asks for. Everything under a tenant is content.
    for (const path of [
      `/tenants/${tenantA}`,
      `/tenants/${tenantA}/calls`,
      `/tenants/${tenantA}/calls/${callA}`,
      `/tenants/${tenantA}/calls/${callA}/recording`,
      `/tenants/${tenantA}/profile`,
    ]) {
      const response = await get(path, tokens.reseller);
      expect(response.status, path).toBe(403);
      const text = await response.text();
      expect(text).not.toContain("Boiler");
      expect(text).not.toContain("+447700900123");
      expect(text).not.toContain("XQ12");
    }
    // What the reseller does get: tenants and counts, no contact details.
    const { tenants } = await json<TenantList>(get("/tenants", tokens.reseller));
    const a = tenants.find((tenant) => tenant.id === tenantA);
    expect(a).toEqual({
      id: tenantA,
      businessName: "Dash Plumbing",
      trade: "plumber",
      status: "onboarding",
      createdAt: expect.any(String) as string,
      calls: { last30Days: expect.any(Number) as number, total: 1 },
    });
    expect(JSON.stringify(tenants)).not.toContain("+447700900701");
  });
});

describe("tenant isolation through the API", () => {
  it("shows an owner only their own tenants", async () => {
    const { tenants } = await json<TenantList>(get("/tenants", tokens.ownerA));
    expect(tenants.map((tenant) => tenant.id)).toEqual([tenantA]);
  });

  it("refuses another tenant's call even by its exact ID", async () => {
    expect((await get(`/tenants/${tenantB}/calls/${callB}`, tokens.ownerA)).status).toBe(403);
    // And the row-level security behind the middleware: tenant A's scope can't see call B.
    expect((await get(`/tenants/${tenantA}/calls/${callB}`, tokens.admin)).status).toBe(404);
    expect((await get(`/tenants/${tenantA}/calls/not-a-uuid`, tokens.admin)).status).toBe(404);
  });

  it("shows the admin everything", async () => {
    const { tenants } = await json<TenantList>(get("/tenants", tokens.admin));
    const ids = tenants.map((tenant) => tenant.id);
    expect(ids).toEqual(expect.arrayContaining([tenantA, tenantB]));
    const detail = await json<object>(get(`/tenants/${tenantB}`, tokens.admin));
    expect(detail).toMatchObject({ businessName: "Other Sparks", trade: "electrician" });
  });
});

describe("calls", () => {
  it("lists a tenant's calls newest first, filtered by urgency and date, in pages", async () => {
    const tenant = await createTenant(admin, { businessName: "List Roofing", trade: "roofer" });
    const token = tokens.admin;
    const ids = [
      await insertCall(tenant, "One", "routine", "2026-11-01T09:00:00Z"),
      await insertCall(tenant, "Two", "urgent", "2026-11-02T09:00:00Z"),
      await insertCall(tenant, "Three", "routine", "2026-11-03T09:00:00Z"),
    ];
    const all = await json<CallList>(get(`/tenants/${tenant}/calls`, token));
    expect(all.calls.map((call) => call.callId)).toEqual([...ids].reverse());
    expect(all.nextBefore).toBeNull();
    expect(all.calls[0]).toEqual({
      callId: ids[2],
      startedAt: "2026-11-03T09:00:00.000Z",
      endedAt: "2026-11-03T09:02:00.000Z",
      durationSeconds: 120,
      callerNumber: "+447700900123",
      urgency: "routine",
      summary: "Three",
      flags: [],
      fields: { callerName: "Sam", callbackNumber: "+447700900123", postcode: "XQ12 3JL" },
      viaFallback: false,
    });
    expect(all.calls[0]).not.toHaveProperty("transcript");

    const urgent = await json<CallList>(get(`/tenants/${tenant}/calls?urgency=urgent`, token));
    expect(summaries(urgent)).toEqual(["Two"]);

    const window = await json<CallList>(
      get(`/tenants/${tenant}/calls?from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z`, token),
    );
    expect(summaries(window)).toEqual(["Two", "One"]);

    const page1 = await json<CallList>(get(`/tenants/${tenant}/calls?limit=2`, token));
    expect(summaries(page1)).toEqual(["Three", "Two"]);
    expect(page1.nextBefore).toBe("2026-11-02T09:00:00.000Z");
    const page2 = await json<CallList>(
      get(`/tenants/${tenant}/calls?limit=2&before=${page1.nextBefore}`, token),
    );
    expect(summaries(page2)).toEqual(["One"]);
    expect(page2.nextBefore).toBeNull();
  });

  it("rejects a bad filter instead of guessing", async () => {
    const response = await get(`/tenants/${tenantA}/calls?urgency=loud&limit=0`, tokens.ownerA);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Record<string, string[]> };
    expect(Object.keys(body.issues).sort()).toEqual(["limit", "urgency"]);
  });

  it("shows the whole call, with the transcript and a recording link, to its owner", async () => {
    const call = await json<object>(get(`/tenants/${tenantA}/calls/${callA}`, tokens.ownerA));
    expect(call).toMatchObject({
      callId: callA,
      summary: "Boiler leaking.",
      transcript: [
        { role: "agent", text: "Hi, how can I help?" },
        { role: "caller", text: "Something is wrong." },
      ],
      recording: { available: true, url: `/api/tenants/${tenantA}/calls/${callA}/recording` },
    });
  });

  it("streams the recording from the voice platform", async () => {
    const providerCallId = (
      await admin.query<{ provider_call_id: string }>(
        "SELECT provider_call_id FROM calls WHERE id = $1",
        [callA],
      )
    ).rows[0]!.provider_call_id;
    voice.recordingAudio.set(providerCallId, new Uint8Array([1, 2, 3]));
    const response = await get(`/tenants/${tenantA}/calls/${callA}/recording`, tokens.ownerA);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

const PROFILE: AgentProfileInput = {
  trade: "plumber",
  services: ["boiler repairs"],
  serviceAreas: ["Leeds"],
  openingHours: { mon: { open: "08:00", close: "18:00" } },
  holidayMode: false,
  holidayUntil: null,
  faqs: [{ question: "Do you do gas?", answer: "Yes, Gas Safe registered." }],
  emergencyPolicy: { takesEmergencyCalls: true },
};

describe("profile", () => {
  it("is null until the first save, then shows the saved version and its sync state", async () => {
    const tenant = await createTenant(admin, { businessName: "Edit Plumbing", trade: "plumber" });
    const owner = await personFor(tenant);
    expect(await json<object>(get(`/tenants/${tenant}/profile`, owner))).toEqual({
      profile: null,
      version: null,
      sync: null,
    });

    const saved = await send("PUT", `/tenants/${tenant}/profile`, PROFILE, owner);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      version: 1,
      sync: { state: "pending", syncedAt: null, error: null },
    });

    const shown = await json<{ profile: AgentProfileInput; version: number; sync: object }>(
      get(`/tenants/${tenant}/profile`, owner),
    );
    expect(shown.profile).toEqual(PROFILE);
    expect(shown.version).toBe(1);
    expect(shown.sync).toEqual({ state: "pending", syncedAt: null, error: null });

    // The save queued the sync and named who did it.
    const jobs = await app.query(
      "SELECT 1 FROM pgboss.job WHERE name = 'sync-agent' AND singleton_key = $1",
      [`${tenant}:1`],
    );
    expect(jobs.rowCount).toBe(1);
    const audit = await admin.query<{ actor_user_id: string | null; details: unknown }>(
      "SELECT actor_user_id, details FROM audit_log WHERE tenant_id = $1 AND action = 'profile.saved'",
      [tenant],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor_user_id).not.toBeNull();
    expect(audit.rows[0]!.details).toEqual({ via: "dashboard", version: 1 });

    // Once the worker has synced or failed, the state says so.
    await admin.query(
      "UPDATE agent_profiles SET sync_error = 'Retell said no' WHERE tenant_id = $1",
      [tenant],
    );
    expect(
      (await json<{ sync: { state: string } }>(get(`/tenants/${tenant}/profile`, owner))).sync
        .state,
    ).toBe("error");
    await admin.query(
      "UPDATE agent_profiles SET sync_error = NULL, synced_at = now() WHERE tenant_id = $1",
      [tenant],
    );
    expect(
      (await json<{ sync: { state: string } }>(get(`/tenants/${tenant}/profile`, owner))).sync
        .state,
    ).toBe("live");
  });

  it("rejects an invalid profile field by field", async () => {
    const response = await send(
      "PUT",
      `/tenants/${tenantA}/profile`,
      { ...PROFILE, trade: "astronaut", services: "boilers" },
      tokens.ownerA,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Record<string, string[]> };
    expect(Object.keys(body.issues).sort()).toEqual(["services", "trade"]);
    expect(
      (await admin.query("SELECT 1 FROM agent_profiles WHERE tenant_id = $1", [tenantA])).rowCount,
    ).toBe(0);
  });
});

describe("switch", () => {
  it("pauses and resumes a live tenant, and records who did it", async () => {
    const tenant = await createTenant(admin, {
      businessName: "Switch Sparks",
      trade: "electrician",
    });
    await admin.query("UPDATE tenants SET status = 'live' WHERE id = $1", [tenant]);
    const owner = await personFor(tenant);

    expect(
      await json<object>(send("PUT", `/tenants/${tenant}/switch`, { on: false }, owner)),
    ).toEqual({ outcome: "paused", status: "paused" });
    expect(
      await json<object>(send("PUT", `/tenants/${tenant}/switch`, { on: false }, owner)),
    ).toEqual({ outcome: "unchanged", status: "paused" });
    expect(
      await json<object>(send("PUT", `/tenants/${tenant}/switch`, { on: true }, owner)),
    ).toEqual({ outcome: "resumed", status: "live" });
    const actions = await admin.query<{ action: string; actor_user_id: string | null }>(
      "SELECT action, actor_user_id FROM audit_log WHERE tenant_id = $1 ORDER BY created_at",
      [tenant],
    );
    expect(actions.rows.map((row) => row.action)).toEqual(["tenant.paused", "tenant.resumed"]);
    expect(actions.rows.every((row) => row.actor_user_id !== null)).toBe(true);
  });

  it("refuses to switch a tenant that isn't live or paused, and a body that isn't a boolean", async () => {
    const refused = await send("PUT", `/tenants/${tenantA}/switch`, { on: false }, tokens.ownerA);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ status: "onboarding" });
    expect(
      (await send("PUT", `/tenants/${tenantA}/switch`, { on: "yes" }, tokens.ownerA)).status,
    ).toBe(400);
  });
});

/** An owner who belongs to just this tenant. */
async function personFor(tenantId: string) {
  const subject = `sub_${randomUUID()}`;
  const email = `owner-${randomUUID()}@example.com`;
  const userId = await createUser(admin, { authSubject: subject, email, role: "owner" });
  await addMembership(admin, tenantId, userId);
  return auth.tokenFor({ subject, email });
}
