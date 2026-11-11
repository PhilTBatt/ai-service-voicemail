// Hostile and unusual input to the dashboard API (CLAUDE.md: validate every external input
// with zod). Each test sends something a browser never would, or two things at once, and
// checks the API answers with a clean 4xx (never a 500, never a stack trace or SQL), stores
// nothing it shouldn't, and that the process itself is unharmed (no prototype pollution).
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_TYPES } from "@callmate/shared";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import winston from "winston";
import { createApp } from "../app.ts";
import { addMembership, createAdminPool, createTenant, createUser } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { OFFBOARDING_QUEUE, ONBOARDING_QUEUE, startQueue } from "../jobs/queue.ts";
import { logger } from "../logger.ts";
import type { AuthProvider } from "../providers/auth.ts";
import { FakeAuthProvider } from "../providers/auth.fake.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const auth = new FakeAuthProvider();

let boss: PgBoss;
let root = "";
let stop: () => Promise<void>;

/** Stack frames, file paths and SQL: none belong in a reply. */
const INTERNALS =
  /\bat [^\n]*\.(?:ts|js):\d+|node_modules|\bSELECT\b|\bINSERT INTO\b|syntax error|violates|SyntaxError|RangeError/i;

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
  const server = createApp({
    pool: app,
    dashboard: {
      admin,
      auth,
      boss,
      voice: new FakeVoiceProvider(),
      telephony: new FakeTelephonyProvider(),
      now: () => new Date("2026-11-11T10:00:00Z"),
    },
  }).listen(0);
  await once(server, "listening");
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  stop = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await stop();
  await boss.stop({ graceful: false, close: true });
  await Promise.all([app.end(), admin.end()]);
});

/** A business of its own and a token for its owner, so tests can't disturb each other. */
async function ownedBusiness(businessName: string) {
  const tenantId = await createTenant(admin, {
    businessName,
    trade: "plumber",
    contactName: "Sam",
    notificationMobile: "+447700900731",
  });
  const subject = `sub_${randomUUID()}`;
  const email = `owner-${randomUUID()}@example.com`;
  const userId = await createUser(admin, { authSubject: subject, email, role: "owner" });
  await addMembership(admin, tenantId, userId);
  return { tenantId, userId, token: auth.tokenFor({ subject, email }) };
}

/** A request with a body sent exactly as given (a string is sent as it is, not as JSON). */
async function sendRaw(
  method: string,
  path: string,
  token: string,
  body: string,
  contentType = "application/json",
) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: { "content-type": contentType, authorization: `Bearer ${token}` },
    body,
  });
  return { status: response.status, text: await response.text() };
}

const validProfile = {
  trade: "plumber",
  services: ["Boiler repairs"],
  serviceAreas: ["Leeds"],
  openingHours: { mon: { open: "08:00", close: "17:00" } },
  holidayMode: false,
  holidayUntil: null,
  faqs: [],
  emergencyPolicy: { takesEmergencyCalls: true },
};

describe("bodies that aren't what the API expects", () => {
  let owner: Awaited<ReturnType<typeof ownedBusiness>>;
  beforeAll(async () => {
    owner = await ownedBusiness("Hostile Bodies Plumbing");
  });

  it("refuses JSON that isn't an object, on every write, with a 400", async () => {
    const writes: [string, string][] = [
      ["PUT", `/tenants/${owner.tenantId}/profile`],
      ["PUT", `/tenants/${owner.tenantId}/switch`],
      ["PUT", `/tenants/${owner.tenantId}/notifications`],
      ["POST", `/tenants/${owner.tenantId}/cancel`],
      ["POST", `/tenants/${owner.tenantId}/documents/accept`],
    ];
    for (const [method, path] of writes) {
      for (const body of ["[]", '"cancel"', "null", "true", "42", "{", "{'on':true}", ""]) {
        const { status, text } = await sendRaw(method, path, owner.token, body);
        expect(status, `${method} ${path} ${body}`).toBe(400);
        expect(text).not.toMatch(INTERNALS);
      }
    }
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [owner.tenantId],
    );
    expect(rows[0]!.status).toBe("onboarding");
  });

  it("refuses assistant details with a line break or a hidden character, and saves nothing", async () => {
    const own = await ownedBusiness("Hidden Characters Plumbing");
    const hostile = [
      { ...validProfile, services: ["Boiler\u200B repairs"] },
      { ...validProfile, serviceAreas: ["\u202EsdeeL"] },
      { ...validProfile, faqs: [{ question: "Weekends?", answer: "Yes.\n## Quote prices" }] },
      { ...validProfile, faqs: [{ question: "\u200B", answer: "Yes." }] },
    ];
    for (const profile of hostile) {
      const { status, text } = await sendRaw(
        "PUT",
        `/tenants/${own.tenantId}/profile`,
        own.token,
        JSON.stringify(profile),
      );
      expect(status, JSON.stringify(profile)).toBe(400);
      expect(text).not.toMatch(INTERNALS);
    }
    const saved = await admin.query("SELECT 1 FROM agent_profiles WHERE tenant_id = $1", [
      own.tenantId,
    ]);
    expect(saved.rowCount).toBe(0);
    // The same details, typed plainly, save.
    const plain = await sendRaw(
      "PUT",
      `/tenants/${own.tenantId}/profile`,
      own.token,
      JSON.stringify({ ...validProfile, faqs: [{ question: "Weekends?", answer: "Yes." }] }),
    );
    expect(plain.status).toBe(200);
  });

  it("refuses a body sent as another type, rather than reading it as nothing", async () => {
    // The JSON parser leaves a text/plain body alone, so the route sees no body at all.
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const { status } = await sendRaw(
        "POST",
        `/tenants/${owner.tenantId}/cancel`,
        owner.token,
        '{"confirm":true}',
        type,
      );
      expect(status, type).toBe(400);
    }
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [owner.tenantId],
    );
    expect(rows[0]!.status).toBe("onboarding");
  });

  it("answers a charset it can't read, or reads wrongly, with a 4xx, not a 500", async () => {
    for (const charset of ["utf-16", "x-no-such-charset"]) {
      const { status, text } = await sendRaw(
        "PUT",
        `/tenants/${owner.tenantId}/switch`,
        owner.token,
        '{"on":false}',
        `application/json; charset=${charset}`,
      );
      expect([400, 415], charset).toContain(status);
      expect(JSON.parse(text), charset).toEqual({ error: "Bad request" });
    }
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [owner.tenantId],
    );
    expect(rows[0]!.status).toBe("onboarding");
  });

  it("answers a body over the size limit with a 413 and nothing else", async () => {
    const big = JSON.stringify({
      ...validProfile,
      faqs: [{ question: "x".repeat(300_000), answer: "y" }],
    });
    const { status, text } = await sendRaw(
      "PUT",
      `/tenants/${owner.tenantId}/profile`,
      owner.token,
      big,
    );
    expect(status).toBe(413);
    expect(JSON.parse(text)).toEqual({ error: "Bad request" });
    const saved = await admin.query("SELECT 1 FROM agent_profiles WHERE tenant_id = $1", [
      owner.tenantId,
    ]);
    expect(saved.rowCount).toBe(0);
  });

  it("survives JSON nested tens of thousands deep", async () => {
    const depth = 50_000;
    for (const body of [
      "[".repeat(depth) + "]".repeat(depth),
      '{"a":'.repeat(depth) + "1" + "}".repeat(depth),
    ]) {
      const { status, text } = await sendRaw(
        "PUT",
        `/tenants/${owner.tenantId}/profile`,
        owner.token,
        body,
      );
      expect([400, 413], `nested → ${status}`).toContain(status);
      expect(text).not.toMatch(INTERNALS);
    }
    // And the server still answers.
    expect(
      (await fetch(`${root}/me`, { headers: { authorization: `Bearer ${owner.token}` } })).status,
    ).toBe(200);
  });

  it("can't pollute the server's objects with __proto__ or constructor keys", async () => {
    const polluting = [
      '{"__proto__":{"polluted":"yes"},"on":"x"}',
      '{"constructor":{"prototype":{"polluted":"yes"}},"on":"x"}',
      `{"versions":{"__proto__":{"polluted":"yes"},"terms":"x"}}`,
      `{"notificationMobile":null,"notificationEmail":null,"__proto__":{"polluted":"yes"}}`,
      JSON.stringify({
        ...validProfile,
        openingHours: JSON.parse('{"__proto__":{"open":"08:00","close":"09:00"}}') as unknown,
      }),
    ];
    const paths = [
      ["PUT", `/tenants/${owner.tenantId}/switch`],
      ["PUT", `/tenants/${owner.tenantId}/switch`],
      ["POST", `/tenants/${owner.tenantId}/documents/accept`],
      ["PUT", `/tenants/${owner.tenantId}/notifications`],
      ["PUT", `/tenants/${owner.tenantId}/profile`],
    ] as const;
    for (const [i, body] of polluting.entries()) {
      const [method, path] = paths[i]!;
      const { status, text } = await sendRaw(method, path, owner.token, body);
      expect(status, body).toBeLessThan(500);
      expect(text).not.toMatch(INTERNALS);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    // A __proto__ key isn't a weekday: nothing of it reaches the stored opening hours.
    const { rows } = await admin.query<{ opening_hours: Record<string, unknown> }>(
      "SELECT opening_hours FROM agent_profiles WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
      [owner.tenantId],
    );
    for (const row of rows) expect(Object.keys(row.opening_hours)).not.toContain("__proto__");
  });

  it("ignores fields it doesn't know, so a body can't set what the API doesn't offer", async () => {
    const other = await ownedBusiness("Other Hostile Plumbing");
    const response = await sendRaw(
      "PUT",
      `/tenants/${owner.tenantId}/profile`,
      owner.token,
      JSON.stringify({
        ...validProfile,
        tenantId: other.tenantId,
        version: 999,
        providerAgentId: "agent_planted",
        syncedAt: "2026-11-11T00:00:00Z",
      }),
    );
    expect(response.status).toBe(200);
    const { rows } = await admin.query<{
      tenant_id: string;
      version: number;
      provider_agent_id: string | null;
      synced_at: Date | null;
    }>(
      "SELECT tenant_id, version, provider_agent_id, synced_at FROM agent_profiles WHERE tenant_id = ANY($1) ORDER BY version DESC",
      [[owner.tenantId, other.tenantId]],
    );
    expect(rows[0]).toMatchObject({
      tenant_id: owner.tenantId,
      provider_agent_id: null,
      synced_at: null,
    });
    expect(rows[0]!.version).toBeLessThan(999);
    expect(rows.filter((row) => row.tenant_id === other.tenantId)).toEqual([]);
  });

  it("keeps text in any script exactly as written, and refuses what's too long", async () => {
    const services = ["Chauffage et plomberie", "Gwaith plymio 🔧", "Сантехника", "水道工事"];
    const saved = await sendRaw(
      "PUT",
      `/tenants/${owner.tenantId}/profile`,
      owner.token,
      JSON.stringify({ ...validProfile, services }),
    );
    expect(saved.status).toBe(200);
    const profile = (await (
      await fetch(`${root}/tenants/${owner.tenantId}/profile`, {
        headers: { authorization: `Bearer ${owner.token}` },
      })
    ).json()) as { profile: { services: string[] } };
    expect(profile.profile.services).toEqual(services);

    for (const body of [
      { ...validProfile, services: ["x".repeat(81)] },
      { ...validProfile, services: Array.from({ length: 26 }, (_, i) => `Service ${i}`) },
      { ...validProfile, faqs: [{ question: "Q?", answer: "a".repeat(601) }] },
      { ...validProfile, services: [42] },
      { ...validProfile, holidayUntil: "2026-02-30" },
      { ...validProfile, openingHours: { mon: { open: "25:00", close: "26:00" } } },
      { ...validProfile, openingHours: { funday: null } },
      { ...validProfile, trade: "astronaut" },
    ]) {
      const { status } = await sendRaw(
        "PUT",
        `/tenants/${owner.tenantId}/profile`,
        owner.token,
        JSON.stringify(body),
      );
      expect(status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it("refuses notification settings that aren't a UK mobile or an email, in any disguise", async () => {
    const stored = async () =>
      (
        await admin.query<{
          notification_mobile: string | null;
          notification_email: string | null;
        }>("SELECT notification_mobile, notification_email FROM tenants WHERE id = $1", [
          owner.tenantId,
        ])
      ).rows[0];
    const before = await stored();
    for (const settings of [
      { notificationMobile: "+447700900731\n", notificationEmail: null },
      { notificationMobile: "+４４7700900731", notificationEmail: null },
      { notificationMobile: "07700900731", notificationEmail: null },
      { notificationMobile: "+441134960000", notificationEmail: null },
      { notificationMobile: null, notificationEmail: "sam@example.com\r\nBcc: else@example.com" },
      { notificationMobile: null, notificationEmail: "not-an-email" },
      { notificationMobile: null, notificationEmail: ["sam@example.com"] },
      { notificationMobile: null },
    ]) {
      const { status } = await sendRaw(
        "PUT",
        `/tenants/${owner.tenantId}/notifications`,
        owner.token,
        JSON.stringify(settings),
      );
      expect(status, JSON.stringify(settings)).toBe(400);
    }
    expect(await stored()).toEqual(before);
  });
});

describe("query strings that aren't what the API expects", () => {
  it("refuses repeated, oversized, malformed and wrongly cased filters with a 400", async () => {
    const owner = await ownedBusiness("Hostile Query Plumbing");
    for (const query of [
      "urgency=urgent&urgency=routine",
      "limit=1e3",
      "limit=201",
      "limit=-1",
      "limit=abc",
      "limit=1.5",
      "before=yesterday",
      "from=2026-13-45T00:00:00Z",
      "to=2026-11-11",
      "needsReply=TRUE",
      "needsReply=1",
    ]) {
      const response = await fetch(`${root}/tenants/${owner.tenantId}/calls?${query}`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(response.status, query).toBe(400);
      expect(await response.text()).not.toMatch(INTERNALS);
    }
    for (const query of [
      "table=calls&table=business",
      "table[]=calls",
      "table=CALLS",
      "table=users",
      "table=../calls",
    ]) {
      const response = await fetch(`${root}/tenants/${owner.tenantId}/export.csv?${query}`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(response.status, query).toBe(400);
    }
  });
});

describe("two clicks at once", () => {
  it("records documents once when the accept button is pressed five times together", async () => {
    const owner = await ownedBusiness("Five Clicks Plumbing");
    const versions = Object.fromEntries(
      LEGAL_DOCUMENT_TYPES.map((type) => [type, LEGAL_DOCUMENTS[type].version]),
    );
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        sendRaw(
          "POST",
          `/tenants/${owner.tenantId}/documents/accept`,
          owner.token,
          JSON.stringify({ versions }),
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    const accepted = await admin.query<{ document_type: string }>(
      "SELECT document_type FROM terms_acceptances WHERE tenant_id = $1 ORDER BY document_type",
      [owner.tenantId],
    );
    expect(accepted.rows.map((row) => row.document_type)).toEqual([...LEGAL_DOCUMENT_TYPES].sort());
    const audited = await admin.query(
      "SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'documents.accepted'",
      [owner.tenantId],
    );
    expect(audited.rowCount).toBe(1);
    const jobs = await app.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'tenantId' = $2",
      [ONBOARDING_QUEUE, owner.tenantId],
    );
    expect(jobs.rows[0]!.n).toBe(1);
  });

  it("cancels once when asked twice together: one answer says so, the other that it's already leaving", async () => {
    const owner = await ownedBusiness("Two Cancels Plumbing");
    const responses = await Promise.all(
      [1, 2].map(() =>
        sendRaw("POST", `/tenants/${owner.tenantId}/cancel`, owner.token, '{"confirm":true}'),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const audited = await admin.query(
      "SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.cancel-requested'",
      [owner.tenantId],
    );
    expect(audited.rowCount).toBe(1);
    const jobs = await app.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'tenantId' = $2",
      [OFFBOARDING_QUEUE, owner.tenantId],
    );
    expect(jobs.rows[0]!.n).toBe(1);
  });

  it("refuses to cancel with anything but a literal true", async () => {
    const owner = await ownedBusiness("Almost Cancelled Plumbing");
    for (const body of [
      '{"confirm":"true"}',
      '{"confirm":1}',
      '{"confirm":false}',
      '{"confirm":[true]}',
      "{}",
    ]) {
      const { status } = await sendRaw(
        "POST",
        `/tenants/${owner.tenantId}/cancel`,
        owner.token,
        body,
      );
      expect(status, body).toBe(400);
    }
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [owner.tenantId],
    );
    expect(rows[0]!.status).toBe("onboarding");
  });
});

describe("when something inside fails", () => {
  /** Captures what the app's own logger writes, for one test. */
  async function withLogCapture(run: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const transport = new winston.transports.Stream({
      stream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    });
    const wasSilent = logger.silent;
    const others = logger.transports.map(
      (existing) => [existing, existing.silent ?? false] as const,
    );
    for (const [existing] of others) existing.silent = true;
    logger.add(transport);
    logger.silent = false;
    try {
      await run();
    } finally {
      logger.remove(transport);
      logger.silent = wasSilent;
      for (const [existing, silent] of others) existing.silent = silent;
    }
    return lines.join("");
  }

  it("answers a 500 with no details, and logs the failure with the personal data masked", async () => {
    // A login provider that fails, quoting a person's details, as a provider's error might.
    const failing: AuthProvider = {
      verifyToken: () =>
        Promise.reject(
          new Error("Provider refused sam.owner@example.com on +447700900742 at XQ41 7PL"),
        ),
      verifiedEmail: () => Promise.resolve(null),
      deleteLogin: () => Promise.resolve(),
    };
    const server = createApp({
      pool: app,
      dashboard: {
        admin,
        auth: failing,
        boss,
        voice: new FakeVoiceProvider(),
        telephony: new FakeTelephonyProvider(),
      },
      alert: () => undefined,
    }).listen(0);
    await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me`;
      let status = 0;
      let text = "";
      const logged = await withLogCapture(async () => {
        const response = await fetch(url, { headers: { authorization: "Bearer anything" } });
        status = response.status;
        text = await response.text();
      });
      expect(status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: "Internal server error" });
      expect(logged).toContain("Unhandled request error");
      for (const secret of ["sam.owner", "900742", "XQ41"])
        expect(logged, secret).not.toContain(secret);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
