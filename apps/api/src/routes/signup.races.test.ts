// Signup links under pressure (BUILD_PLAN Step 11): single use when two people follow one link
// at the same moment, one business when one person follows two links at once, the exact
// moment a link expires, and bodies that try to set what the form doesn't offer.
// signup.test.ts covers the ordinary journeys.
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { LEGAL_DOCUMENTS } from "@callmate/shared";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  SIGNUP_LINK_TTL_MS,
  createAdminPool,
  createSignupLink,
  createUser,
  inviteUser,
} from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { startQueue } from "../jobs/queue.ts";
import { FakeAuthProvider } from "../providers/auth.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

const NOW = new Date("2026-11-11T10:00:00.000Z");
const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const auth = new FakeAuthProvider();
let boss: PgBoss;
let root = "";
let stop: () => Promise<void>;
let staffId = "";

/** Stack frames, file paths and SQL: none belong in a reply. */
const INTERNALS =
  /\bat [^\n]*\.(?:ts|js):\d+|node_modules|\bSELECT\b|\bINSERT INTO\b|violates|duplicate key/i;

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
  const server = createApp({ pool: app, dashboard: { admin, auth, boss, now: () => NOW } }).listen(
    0,
  );
  await once(server, "listening");
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  stop = () => new Promise((resolve) => server.close(() => resolve()));
  staffId = await createUser(admin, {
    authSubject: `sub_${randomUUID()}`,
    email: `staff-${randomUUID()}@example.com`,
    role: "admin",
  });
});

afterAll(async () => {
  await stop();
  await boss.stop({ graceful: false, close: true });
  await Promise.all([app.end(), admin.end()]);
});

const ACCEPTED = {
  terms: LEGAL_DOCUMENTS.terms.version,
  dpa: LEGAL_DOCUMENTS.dpa.version,
  privacy_notice: LEGAL_DOCUMENTS.privacy_notice.version,
};

const form = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  businessName: "Race Lane Heating",
  trade: "heating_engineer",
  contactName: "Alex",
  mobile: "+447700900561",
  email: null,
  mobileNetwork: "ee",
  usesNetworkVoicemail: false,
  accepted: ACCEPTED,
  ...extra,
});

/** A link made at `madeAt` (so it expires SIGNUP_LINK_TTL_MS later). */
async function link(madeAt = NOW) {
  return (await createSignupLink(admin, { createdBy: staffId, forTest: false, now: madeAt })).code;
}

function newcomer(email = `new-${randomUUID()}@example.com`) {
  const subject = `sub_${randomUUID()}`;
  return { subject, email, token: auth.tokenFor({ subject, email }) };
}

async function signup(body: unknown, token: string) {
  const response = await fetch(`${root}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const businessesFromLink = async (code: string) =>
  (
    await admin.query<{ tenant_id: string | null; used_at: Date | null }>(
      "SELECT tenant_id, used_at FROM signup_links WHERE code_hash = $1",
      [createHash("sha256").update(code).digest("hex")],
    )
  ).rows[0];

describe("one link, followed by two people at the same moment", () => {
  it("makes exactly one business, and turns the other person away cleanly", async () => {
    const code = await link();
    const people = [newcomer(), newcomer(), newcomer()];
    const results = await Promise.all(people.map((person) => signup(form(code), person.token)));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409, 409]);
    for (const result of results) expect(result.text).not.toMatch(INTERNALS);

    const created = await businessesFromLink(code);
    expect(created?.tenant_id).toEqual(expect.any(String));
    // Only the winner has an account; the others can still sign up with another link.
    const accounts = await admin.query<{ email: string }>(
      "SELECT email FROM users WHERE auth_subject = ANY($1)",
      [people.map((person) => person.subject)],
    );
    expect(accounts.rowCount).toBe(1);
    const tenants = await admin.query(
      "SELECT 1 FROM tenant_memberships m JOIN users u ON u.id = m.user_id WHERE u.auth_subject = ANY($1)",
      [people.map((person) => person.subject)],
    );
    expect(tenants.rowCount).toBe(1);
  });
});

describe("one person, following two links at once", () => {
  it("gets one business and one account, and a clean refusal for the other link", async () => {
    // Two tabs, or a double click on two links Ant sent. The second used to reach the users
    // table's unique index and come back as a 500, with a business half-made and rolled back.
    const person = newcomer();
    const codes = [await link(), await link()];
    const results = await Promise.all(codes.map((code) => signup(form(code), person.token)));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const refused = results.find((result) => result.status === 409)!;
    expect(JSON.parse(refused.text)).toEqual({
      error: "You already have an AnswerMate account. Sign in to see it.",
    });
    const accounts = await admin.query("SELECT 1 FROM users WHERE auth_subject = $1", [
      person.subject,
    ]);
    expect(accounts.rowCount).toBe(1);
    // The losing link is still unused, so it can go to someone else.
    const states = await Promise.all(codes.map(businessesFromLink));
    expect(states.filter((state) => state?.used_at === null)).toHaveLength(1);
  });
});

describe("the moment a link expires", () => {
  it("still works a millisecond before, and is expired at the instant itself", async () => {
    const almost = await link(new Date(NOW.getTime() - SIGNUP_LINK_TTL_MS + 1));
    const exactly = await link(new Date(NOW.getTime() - SIGNUP_LINK_TTL_MS));
    expect((await fetch(`${root}/signup/${almost}`)).status).toBe(200);
    expect((await fetch(`${root}/signup/${exactly}`)).status).toBe(410);
    const late = await signup(form(exactly), newcomer().token);
    expect(late.status).toBe(409);
    expect(JSON.parse(late.text)).toEqual({
      error: "This signup link has expired; ask for a new one",
    });
    expect((await signup(form(almost), newcomer().token)).status).toBe(201);
  });

  it("lasts 14 days from when it's made", async () => {
    const response = await fetch(`${root}/signup/${await link()}`);
    const { expiresAt } = (await response.json()) as { expiresAt: string };
    expect(expiresAt).toBe(new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString());
  });
});

describe("links that aren't links", () => {
  it("answers a code of any shape or length with a plain 404, saying nothing more", async () => {
    for (const code of [
      "a",
      "x".repeat(5_000),
      encodeURIComponent("' OR '1'='1"),
      encodeURIComponent("../../admin"),
      "%00",
      encodeURIComponent("🔗🔗🔗🔗🔗🔗🔗🔗"),
    ]) {
      const response = await fetch(`${root}/signup/${code}`);
      expect(response.status, code.slice(0, 20)).toBe(404);
      expect(await response.json()).toEqual({ error: "This signup link isn't valid" });
    }
  });

  it("says nothing about the business a used link made", async () => {
    const code = await link();
    expect((await signup(form(code), newcomer().token)).status).toBe(201);
    const response = await fetch(`${root}/signup/${code}`);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "This signup link has already been used" });
  });

  it("makes codes that don't repeat and can't be guessed from one another", async () => {
    const codes = await Promise.all(Array.from({ length: 30 }, () => link()));
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});

describe("signup bodies that try too much", () => {
  it("ignores fields the form doesn't have: the business starts as any other", async () => {
    const code = await link();
    const person = newcomer();
    const result = await signup(
      form(code, {
        role: "admin",
        status: "live",
        isTest: true,
        is_test: true,
        isPilot: true,
        onboardingState: "live",
        tenantId: randomUUID(),
        forTest: true,
      }),
      person.token,
    );
    expect(result.status).toBe(201);
    const { tenantId } = JSON.parse(result.text) as { tenantId: string };
    const { rows } = await admin.query(
      "SELECT status, is_test, is_pilot, onboarding_state FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(rows[0]).toEqual({
      status: "onboarding",
      is_test: false,
      is_pilot: false,
      onboarding_state: "terms_accepted",
    });
    const role = await admin.query<{ role: string }>(
      "SELECT role FROM users WHERE auth_subject = $1",
      [person.subject],
    );
    expect(role.rows[0]!.role).toBe("owner");
  });

  it("can't pollute the server's objects", async () => {
    const code = await link();
    const body = JSON.stringify(form(code)).replace(
      "{",
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},',
    );
    const result = await signup(body, newcomer().token);
    expect(result.status).toBe(201);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("refuses wrong types, missing parts and oversized bodies with a 4xx and no internals", async () => {
    const code = await link();
    const token = newcomer().token;
    for (const body of [
      "[]",
      "null",
      '"signup"',
      JSON.stringify(form(code, { trade: ["plumber"] })),
      JSON.stringify(form(code, { usesNetworkVoicemail: "yes" })),
      JSON.stringify(form(code, { mobile: 447700900561 })),
      JSON.stringify(form(code, { businessName: "   " })),
      JSON.stringify(form(code, { businessName: "B".repeat(101) })),
      JSON.stringify(form(code, { contactName: "C".repeat(61) })),
      JSON.stringify(form(code, { email: "not an email" })),
      JSON.stringify(form(code, { accepted: { terms: ACCEPTED.terms } })),
      JSON.stringify(form(code, { code: "short" })),
      JSON.stringify(form(code, { mobileNetwork: "carrier-pigeon" })),
    ]) {
      const result = await signup(body, token);
      expect(result.status, body.slice(0, 60)).toBe(400);
      expect(result.text).not.toMatch(INTERNALS);
    }
    // Over the 32 KB limit for this route.
    const big = await signup(JSON.stringify(form(code, { padding: "p".repeat(40_000) })), token);
    expect(big.status).toBe(413);
    expect(JSON.parse(big.text)).toEqual({ error: "Bad request" });
    // None of it used the link.
    expect((await businessesFromLink(code))?.used_at).toBeNull();
  });

  it("turns away an address invited already, whatever its capitals", async () => {
    // One account per address (users_email_unique): an invited owner signs in, not up.
    const email = `Invited-${randomUUID()}@Example.com`;
    await inviteUser(admin, { email, role: "owner" });
    const person = newcomer(email.toLowerCase());
    const result = await signup(form(await link()), person.token);
    expect(result.status).toBe(409);
    expect(JSON.parse(result.text)).toEqual({
      error: "You already have an AnswerMate account. Sign in to see it.",
    });
  });
});
