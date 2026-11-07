import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { addMembership, createAdminPool, createTenant, createUser } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { FakeAuthProvider } from "../providers/auth.fake.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const auth = new FakeAuthProvider();
const voice = new FakeVoiceProvider();
const telephony = new FakeTelephonyProvider();

let get: (path: string, token?: string) => Promise<Response>;
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
  const server = createApp({
    pool: app,
    dashboard: { admin, auth, voice, telephony },
  }).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  get = (path, token) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
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
  const endpoints = () => [
    { name: "GET /me", path: "/me" },
    { name: "GET /tenants", path: "/tenants" },
    { name: "GET /tenants/:id", path: `/tenants/${tenantA}` },
    { name: "GET /tenants/:id/calls", path: `/tenants/${tenantA}/calls` },
    { name: "GET /tenants/:id/calls/:callId", path: `/tenants/${tenantA}/calls/${callA}` },
    {
      name: "GET /tenants/:id/calls/:callId/recording",
      path: `/tenants/${tenantA}/calls/${callA}/recording`,
    },
  ];
  // What tenant A's data looks like to each person. "allowed" means not a 401/403; the
  // recording may 404 because the fake voice provider holds no audio, and that's fine.
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
        const { status } = await get(endpoint.path, tokens[who]);
        if (want === "allowed") {
          expect([200, 404], `${who} ${endpoint.name} → ${status}`).toContain(status);
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
