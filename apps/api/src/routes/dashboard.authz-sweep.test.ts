// Who can open which door, for EVERY route the dashboard API has (BUILD_PLAN Step 10).
//
// dashboard.test.ts has the named matrix. This file differs in three ways:
//   - it reads the routes out of the Express router itself, so a route added without a row
//     here fails the first test, instead of shipping with nobody having checked who reaches it;
//   - it tries every route as every kind of caller, including the ones that must be turned
//     away before anything else happens: no token, a forged one, a revoked one, the wrong
//     scheme, someone logged in who was never invited, and an owner of two businesses;
//   - it reads every answer, allowed or not, and fails on any call content reaching the
//     reseller (or anyone it doesn't belong to) and on any stack trace or SQL in a reply.
// Bodies are chosen so that even an allowed caller changes nothing: each write is refused on
// its merits (400, 409) or by a provider that isn't configured here (503).
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { addMembership, createAdminPool, createTenant, createUser } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { startQueue } from "../jobs/queue.ts";
import { FakeAuthProvider } from "../providers/auth.fake.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { dashboardRouter } from "./dashboard.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const auth = new FakeAuthProvider();
const voice = new FakeVoiceProvider();
const telephony = new FakeTelephonyProvider();

let boss: PgBoss;
let port = 0;
let stop: () => Promise<void>;

let tenantA = "";
let tenantB = "";
let callA = "";
let callB = "";

// Made-up words and Ofcom drama numbers that appear only in the two businesses' rows: finding
// one in a reply that shouldn't carry it is a leak.
const CONTENT = {
  A: {
    summary: "Glimmerton boiler fault",
    transcript: "pellucid radiator hissing",
    caller: "+447700900811",
    callerName: "Ostrander",
    postcode: "XQ31 4AB",
    mobile: "+447700900812",
    email: "sweep-owner-a@example.com",
    contactName: "Thessaly",
  },
  B: {
    summary: "Brindlemoor fuse tripping",
    transcript: "quarrelsome socket sparking",
    caller: "+447700900821",
    callerName: "Wendeline",
    postcode: "XQ32 5CD",
    mobile: "+447700900822",
    email: "sweep-owner-b@example.com",
    contactName: "Corvinus",
  },
};
const ALL_CONTENT = [...Object.values(CONTENT.A), ...Object.values(CONTENT.B)];

/** Stack frames, file paths and SQL: none belong in a reply to the browser. */
const INTERNALS =
  /\bat [^\n]*\.(?:ts|js):\d+|node_modules|\bSELECT\b|\bINSERT INTO\b|syntax error|violates|ECONNREFUSED|pg_/i;

type Caller =
  | "admin"
  | "ownerA"
  | "ownerB"
  | "ownerAB"
  | "reseller"
  | "stranger"
  | "anonymous"
  | "forged"
  | "revoked"
  | "basic"
  | "emptyBearer";
const headers = {} as Record<Caller, Record<string, string>>;

async function business(name: string, content: (typeof CONTENT)["A"]) {
  const tenantId = await createTenant(admin, {
    businessName: name,
    trade: "plumber",
    contactName: content.contactName,
    notificationMobile: content.mobile,
    notificationEmail: content.email,
  });
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                        summary, transcript, extracted_fields, urgency, recording_ref)
     VALUES ($1, $2, $3, now(), now(), $4, $5, $6, 'urgent', 'rec')
     RETURNING id`,
    [
      tenantId,
      `call_${randomUUID()}`,
      content.caller,
      content.summary,
      `caller: ${content.transcript}`,
      {
        callerName: content.callerName,
        callbackNumber: content.caller,
        postcode: content.postcode,
      },
    ],
  );
  return { tenantId, callId: rows[0]!.id };
}

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
  // No payments provider and no number buying: those routes answer 503 to anyone allowed in,
  // so the sweep can never start a Direct Debit or buy a number.
  const server = createApp({
    pool: app,
    dashboard: { admin, auth, boss, voice, telephony, now: () => new Date("2026-11-11T10:00:00Z") },
  }).listen(0);
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  stop = () => new Promise((resolve) => server.close(() => resolve()));

  ({ tenantId: tenantA, callId: callA } = await business("Sweep A Plumbing", CONTENT.A));
  ({ tenantId: tenantB, callId: callB } = await business("Sweep B Electrics", CONTENT.B));

  const person = async (role: "owner" | "admin" | "reseller", tenantIds: string[] = []) => {
    const subject = `sub_${randomUUID()}`;
    const email = `${role}-${randomUUID()}@example.com`;
    const userId = await createUser(admin, { authSubject: subject, email, role });
    for (const tenantId of tenantIds) await addMembership(admin, tenantId, userId);
    return { authorization: `Bearer ${auth.tokenFor({ subject, email })}` };
  };
  headers.admin = await person("admin");
  headers.ownerA = await person("owner", [tenantA]);
  headers.ownerB = await person("owner", [tenantB]);
  headers.ownerAB = await person("owner", [tenantA, tenantB]);
  headers.reseller = await person("reseller");
  headers.stranger = {
    authorization: `Bearer ${auth.tokenFor({ subject: `sub_${randomUUID()}`, email: "nobody@example.com" })}`,
  };
  headers.anonymous = {};
  headers.forged = { authorization: "Bearer fake_00000000-0000-4000-8000-000000000000" };
  const revoked = auth.tokenFor({ subject: `sub_${randomUUID()}`, email: "gone@example.com" });
  auth.revoke(revoked);
  headers.revoked = { authorization: `Bearer ${revoked}` };
  // The admin's own token, but under the wrong scheme: not a bearer token, so no login.
  headers.basic = { authorization: (headers.admin.authorization ?? "").replace("Bearer", "Basic") };
  headers.emptyBearer = { authorization: "Bearer " };
});

afterAll(async () => {
  await stop();
  await boss.stop({ graceful: false, close: true });
  await Promise.all([app.end(), admin.end()]);
});

/** Who a route is for. */
type Access =
  /** Anyone with an account. */
  | "account"
  /** The admin and the reseller (making signup links). */
  | "staff"
  /** The business's owners and the admin: everything under /tenants/:tenantId. */
  | "business"
  /** The business's owners only: the business agrees to its own documents. */
  | "business-owner"
  /** The admin only. */
  | "admin";

interface Door {
  access: Access;
  path: (ids: { tenant: string; call: string }) => string;
  body?: unknown;
}

/** Every route, by method and the path Express registered it under. */
const DOORS: Record<string, Door> = {
  "GET /me": { access: "account", path: () => "/me" },
  "GET /tenants": { access: "account", path: () => "/tenants" },
  "POST /signup-links": { access: "staff", path: () => "/signup-links", body: {} },

  "GET /tenants/:tenantId": { access: "business", path: ({ tenant }) => `/tenants/${tenant}` },
  "GET /tenants/:tenantId/documents": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/documents`,
  },
  "POST /tenants/:tenantId/documents/accept": {
    access: "business-owner",
    path: ({ tenant }) => `/tenants/${tenant}/documents/accept`,
    body: {},
  },
  "GET /tenants/:tenantId/profile": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/profile`,
  },
  "PUT /tenants/:tenantId/profile": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/profile`,
    body: {},
  },
  "PUT /tenants/:tenantId/switch": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/switch`,
    body: { on: "maybe" },
  },
  "PUT /tenants/:tenantId/notifications": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/notifications`,
    body: {},
  },
  "POST /tenants/:tenantId/cancel": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/cancel`,
    body: {},
  },
  "GET /tenants/:tenantId/billing": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/billing`,
  },
  "POST /tenants/:tenantId/billing/direct-debit": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/billing/direct-debit`,
    body: {},
  },
  "POST /tenants/:tenantId/billing/direct-debit/check": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/billing/direct-debit/check`,
    body: {},
  },
  "GET /tenants/:tenantId/export.csv": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/export.csv?table=calls`,
  },
  "GET /tenants/:tenantId/export": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/export`,
  },
  "GET /tenants/:tenantId/calls": {
    access: "business",
    path: ({ tenant }) => `/tenants/${tenant}/calls`,
  },
  "GET /tenants/:tenantId/calls/:callId": {
    access: "business",
    path: ({ tenant, call }) => `/tenants/${tenant}/calls/${call}`,
  },
  "PUT /tenants/:tenantId/calls/:callId/handled": {
    access: "business",
    path: ({ tenant, call }) => `/tenants/${tenant}/calls/${call}/handled`,
    body: {},
  },
  "GET /tenants/:tenantId/calls/:callId/recording": {
    access: "business",
    path: ({ tenant, call }) => `/tenants/${tenant}/calls/${call}/recording`,
  },

  "GET /admin/billing": { access: "admin", path: () => "/admin/billing" },
  "POST /admin/charges/:chargeId/collect-again": {
    access: "admin",
    path: () => `/admin/charges/${randomUUID()}/collect-again`,
    body: {},
  },
  "POST /admin/tenants/:tenantId/suspend": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/suspend`,
    body: {},
  },
  // Both businesses are onboarding, not suspended: 409 even for the admin.
  "POST /admin/tenants/:tenantId/resume": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/resume`,
    body: {},
  },
  "POST /admin/tenants/:tenantId/undo-cancellation": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/undo-cancellation`,
    body: {},
  },
  "GET /admin/health": { access: "admin", path: () => "/admin/health" },
  "PUT /admin/kill-switch": { access: "admin", path: () => "/admin/kill-switch", body: {} },
  "GET /admin/review-queue": { access: "admin", path: () => "/admin/review-queue" },
  "POST /admin/calls/:callId/reviewed": {
    access: "admin",
    path: () => `/admin/calls/${randomUUID()}/reviewed`,
    body: {},
  },
  "GET /admin/usage": { access: "admin", path: () => "/admin/usage" },
  "GET /admin/costs": { access: "admin", path: () => "/admin/costs" },
  "GET /admin/numbers/available": { access: "admin", path: () => "/admin/numbers/available" },
  "POST /admin/tenants/:tenantId/number": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/number`,
    body: {},
  },
  "GET /admin/cancellations": { access: "admin", path: () => "/admin/cancellations" },
  "POST /admin/tenants/:tenantId/release-number": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/release-number`,
    body: {},
  },
  "POST /admin/tenants/:tenantId/delete-data": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/delete-data`,
    body: {},
  },
  "GET /admin/tenants/:tenantId/onboarding": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/onboarding`,
  },
  "POST /admin/tenants/:tenantId/onboarding/advance": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/onboarding/advance`,
    body: {},
  },
  // Neither business has a number: 409 even for the admin, and nothing is queued.
  "POST /admin/tenants/:tenantId/onboarding/divert-instructions": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/onboarding/divert-instructions`,
    body: {},
  },
  "PUT /admin/tenants/:tenantId/pilot": {
    access: "admin",
    path: ({ tenant }) => `/admin/tenants/${tenant}/pilot`,
    body: {},
  },
};

/** Where the router mounts its sub-routers. A new mount must be added here to be swept. */
const MOUNTS = ["/admin", "/tenants/:tenantId"];

interface LayerLike {
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: LayerLike[] };
  matchers?: ((path: string) => false | { path: string })[];
}

/** Every "METHOD /path" the router answers, read from Express's own route table. */
function registeredRoutes(stack: LayerLike[], prefix = ""): string[] {
  return stack.flatMap((layer) => {
    if (layer.route) {
      const path = `${prefix}${layer.route.path === "/" && prefix ? "" : layer.route.path}`;
      return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${path}`);
    }
    if (!layer.handle.stack) return [];
    // A mounted router keeps no copy of its path, only a matcher: ask it which mount it is.
    const mount = MOUNTS.find((candidate) => {
      const match = layer.matchers?.[0]?.(`${candidate}/probe`);
      return match !== false && match?.path === candidate;
    });
    if (mount === undefined)
      throw new Error("A router is mounted at a path this sweep doesn't know");
    return registeredRoutes(layer.handle.stack, `${prefix}${mount}`);
  });
}

/** Whether this caller should get through this door to business A. */
function allowed(caller: Caller, access: Access): boolean {
  switch (caller) {
    case "admin":
      return access !== "business-owner";
    case "ownerA":
    case "ownerAB":
      return access === "account" || access === "business" || access === "business-owner";
    case "ownerB":
      return access === "account";
    case "reseller":
      return access === "account" || access === "staff";
    default:
      return false;
  }
}

/** What a turned-away caller gets: 401 without a usable login, 403 with one. */
function refusal(caller: Caller): 401 | 403 {
  return ["anonymous", "forged", "revoked", "basic", "emptyBearer"].includes(caller) ? 401 : 403;
}

async function knock(
  door: Door,
  caller: Caller,
  ids = { tenant: tenantA, call: callA },
  method?: string,
) {
  const verb = method ?? (door.body === undefined ? "GET" : "POST");
  const response = await fetch(`http://127.0.0.1:${port}/api${door.path(ids)}`, {
    method: verb,
    headers: {
      ...headers[caller],
      ...(door.body !== undefined && { "content-type": "application/json" }),
    },
    ...(door.body !== undefined && { body: JSON.stringify(door.body) }),
  });
  const text = verb === "HEAD" ? "" : await response.text();
  return { status: response.status, text, type: response.headers.get("content-type") ?? "" };
}

/** The method a door is registered under. */
const methodOf = (name: string) => name.split(" ")[0]!;

describe("the sweep covers every route", () => {
  it("has a row for every route the dashboard router registers, and none for routes that are gone", () => {
    const router = dashboardRouter({ pool: app, admin, auth, boss, voice, telephony });
    const registered = registeredRoutes((router as unknown as { stack: LayerLike[] }).stack);
    expect(registered.length).toBeGreaterThan(30);
    expect([...registered].sort()).toEqual(Object.keys(DOORS).sort());
  });
});

describe("every route, as every kind of caller", () => {
  const callers: Caller[] = [
    "admin",
    "ownerA",
    "ownerB",
    "ownerAB",
    "reseller",
    "stranger",
    "anonymous",
    "forged",
    "revoked",
    "basic",
    "emptyBearer",
  ];
  for (const caller of callers) {
    it(`${caller} gets in exactly where they should, and sees nothing that isn't theirs`, async () => {
      for (const [name, door] of Object.entries(DOORS)) {
        const { status, text } = await knock(door, caller, undefined, methodOf(name));
        if (allowed(caller, door.access)) {
          expect([200, 201, 202, 400, 404, 409, 503], `${caller} ${name} → ${status}`).toContain(
            status,
          );
        } else {
          expect(status, `${caller} ${name}`).toBe(refusal(caller));
          // A refusal says nothing about what's behind the door.
          for (const value of ALL_CONTENT) expect(text, `${caller} ${name}`).not.toContain(value);
        }
        expect(text, `${caller} ${name}`).not.toMatch(INTERNALS);
        // Nobody but the businesses' owners and the admin sees business B's content, and
        // business A's is never in a reply about anything but business A.
        if (!["admin", "ownerA", "ownerAB"].includes(caller)) {
          for (const value of Object.values(CONTENT.A)) {
            expect(text, `${caller} ${name}`).not.toContain(value);
          }
        }
        for (const value of [CONTENT.B.summary, CONTENT.B.transcript, CONTENT.B.callerName]) {
          expect(text, `${caller} ${name} shows business B's call`).not.toContain(value);
        }
      }
    });
  }

  it("lets an owner of two businesses into both, and an owner of one into only theirs", async () => {
    const calls = DOORS["GET /tenants/:tenantId/calls"]!;
    for (const [caller, tenant, want] of [
      ["ownerAB", tenantB, 200],
      ["ownerAB", tenantA, 200],
      ["ownerA", tenantB, 403],
      ["ownerB", tenantA, 403],
    ] as const) {
      const { status, text } = await knock(calls, caller, { tenant, call: callA });
      expect(status, `${caller} → ${tenant}`).toBe(want);
      if (want === 403) expect(text).toBe('{"error":"Forbidden"}');
    }
  });

  it("gives the reseller the list and counts, and never a business's contact details", async () => {
    const { status, text } = await knock(DOORS["GET /tenants"]!, "reseller");
    expect(status).toBe(200);
    for (const value of ALL_CONTENT) expect(text).not.toContain(value);
    const { tenants } = JSON.parse(text) as { tenants: Record<string, unknown>[] };
    const a = tenants.find((tenant) => tenant.id === tenantA);
    expect(Object.keys(a ?? {}).sort()).toEqual(
      [
        "billing",
        "businessName",
        "calls",
        "createdAt",
        "id",
        "onboardingState",
        "status",
        "trade",
      ].sort(),
    );
  });
});

describe("other ways in", () => {
  /** A raw request, so the path reaches the server exactly as written (fetch would tidy it). */
  function raw(
    method: string,
    path: string,
    caller: Caller,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method, path, headers: headers[caller] },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("won't reach another business by dot segments, encoded slashes, case or slashes", async () => {
    for (const path of [
      `/api/tenants/${tenantA}/../${tenantB}/calls`,
      `/api/tenants/${tenantA}/%2e%2e/${tenantB}/calls`,
      `/api/tenants/${tenantB}%2Fcalls`,
      `/api/tenants/${tenantB.toUpperCase()}/calls`,
      `/api/tenants/${tenantB}/calls/`,
      `/api/TENANTS/${tenantB}/calls`,
      `/api//tenants/${tenantB}/calls`,
      `/api/tenants/${tenantB}/calls?tenantId=${tenantA}`,
      `/api/tenants/${tenantA},${tenantB}/calls`,
    ]) {
      const { status, text } = await raw("GET", path, "ownerA");
      expect([403, 404], `${path} → ${status}`).toContain(status);
      for (const value of Object.values(CONTENT.B)) expect(text, path).not.toContain(value);
      expect(text, path).not.toMatch(INTERNALS);
    }
  });

  it("asks for a login before anything, whatever the method", async () => {
    for (const method of ["HEAD", "OPTIONS", "DELETE", "PATCH", "TRACE"]) {
      const { status, text } = await raw(method, `/api/tenants/${tenantB}/calls`, "anonymous");
      expect(status, method).toBe(401);
      for (const value of Object.values(CONTENT.B)) expect(text, method).not.toContain(value);
    }
    // A logged-in owner of another business is still turned away by HEAD and OPTIONS.
    for (const method of ["HEAD", "OPTIONS"]) {
      expect((await raw(method, `/api/tenants/${tenantB}/calls`, "ownerA")).status, method).toBe(
        403,
      );
    }
  });

  it("finds nothing of another business's when its call ID is asked for under one's own", async () => {
    for (const name of [
      "GET /tenants/:tenantId/calls/:callId",
      "GET /tenants/:tenantId/calls/:callId/recording",
    ]) {
      const { status, text } = await knock(DOORS[name]!, "ownerA", {
        tenant: tenantA,
        call: callB,
      });
      expect(status, name).toBe(404);
      for (const value of Object.values(CONTENT.B)) expect(text, name).not.toContain(value);
    }
    const marked = await fetch(
      `http://127.0.0.1:${port}/api/tenants/${tenantA}/calls/${callB}/handled`,
      {
        method: "PUT",
        headers: { ...headers.ownerA, "content-type": "application/json" },
        body: JSON.stringify({ handled: true }),
      },
    );
    expect(marked.status).toBe(404);
    const { rows } = await admin.query<{ handled_at: Date | null }>(
      "SELECT handled_at FROM calls WHERE id = $1",
      [callB],
    );
    expect(rows[0]!.handled_at).toBeNull();
  });

  it("never caches an answer, a refusal included", async () => {
    for (const caller of ["ownerA", "ownerB", "reseller", "anonymous"] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/api/tenants/${tenantA}/calls`, {
        headers: headers[caller],
      });
      expect(response.headers.get("cache-control"), caller).toBe("no-store");
    }
  });
});
