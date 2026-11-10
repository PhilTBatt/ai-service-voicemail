import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  LEGAL_DOCUMENTS,
  type CreatedSignupLinkView,
  type MeView,
  type SignupLinkView,
  type SignupResultView,
} from "@callmate/shared";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createAdminPool, createUser } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { startQueue } from "../jobs/queue.ts";
import { FakeAuthProvider } from "../providers/auth.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const auth = new FakeAuthProvider();
let boss: PgBoss;
let call: (method: string, path: string, body?: unknown, token?: string) => Promise<Response>;
let stop: () => Promise<void>;
const tokens = {} as Record<"admin" | "reseller" | "owner", string>;

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
  const server = createApp({ pool: app, dashboard: { admin, auth, boss } }).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  call = (method, path, body, token) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined && { "content-type": "application/json" }),
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  stop = () => new Promise((resolve) => server.close(() => resolve()));

  for (const role of ["admin", "reseller", "owner"] as const) {
    const subject = `sub_${randomUUID()}`;
    const email = `${role}-${randomUUID()}@example.com`;
    await createUser(admin, { authSubject: subject, email, role });
    tokens[role] = auth.tokenFor({ subject, email });
  }
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

const form = (code: string) => ({
  code,
  businessName: "Brook Street Heating",
  trade: "heating_engineer",
  contactName: "Alex",
  mobile: "+447700900555",
  email: null,
  mobileNetwork: "o2",
  usesNetworkVoicemail: true,
  accepted: ACCEPTED,
});

async function newLink(token = tokens.admin, forTest = false): Promise<CreatedSignupLinkView> {
  const response = await call("POST", "/signup-links", { forTest }, token);
  expect(response.status).toBe(201);
  return (await response.json()) as CreatedSignupLinkView;
}

/** Someone signed in with the login provider who has no account here yet. */
function newcomer(verified = true) {
  const email = `new-${randomUUID()}@example.com`;
  const token = auth.tokenFor({ subject: `sub_${randomUUID()}`, email: verified ? email : null });
  return { email, token };
}

const linkStatus = async (code: string) => (await call("GET", `/signup/${code}`)).status;

describe("signup links", () => {
  it("can be made by the admin and the reseller, and only the admin can make a test one", async () => {
    expect((await newLink(tokens.admin, true)).forTest).toBe(true);
    const fromReseller = await newLink(tokens.reseller, true);
    expect(fromReseller.forTest).toBe(false);
    expect(fromReseller.code.length).toBeGreaterThanOrEqual(24);
    expect((await call("POST", "/signup-links", {}, tokens.owner)).status).toBe(403);
    expect((await call("POST", "/signup-links", {})).status).toBe(401);
  });

  it("say whether they can be used, and which documents will be accepted", async () => {
    const { code } = await newLink();
    const response = await call("GET", `/signup/${code}`);
    expect(response.status).toBe(200);
    const link = (await response.json()) as SignupLinkView;
    expect(link.documents).toEqual(LEGAL_DOCUMENTS);
    expect(link.forTest).toBe(false);
    expect(await linkStatus("not-a-real-code-at-all-0000")).toBe(404);
  });

  it("only keep a hash of the code", async () => {
    const { code } = await newLink();
    const hash = createHash("sha256").update(code).digest("hex");
    const stored = await admin.query("SELECT 1 FROM signup_links WHERE code_hash = $1", [hash]);
    expect(stored.rowCount).toBe(1);
    const leaked = await admin.query("SELECT 1 FROM signup_links WHERE code_hash = $1", [code]);
    expect(leaked.rowCount).toBe(0);
  });
});

describe("POST /api/signup", () => {
  it("creates the business and its owner for the person signed in, and only once", async () => {
    const { code } = await newLink();
    const person = newcomer();
    expect((await call("POST", "/signup", form(code))).status).toBe(401);

    const response = await call("POST", "/signup", form(code), person.token);
    expect(response.status).toBe(201);
    const { tenantId } = (await response.json()) as SignupResultView;

    const tenant = (
      await admin.query(
        `SELECT business_name, trade, status, onboarding_state, notification_mobile, notification_email,
                contact_name, mobile_network, uses_network_voicemail, is_test
         FROM tenants WHERE id = $1`,
        [tenantId],
      )
    ).rows[0] as Record<string, unknown>;
    expect(tenant).toEqual({
      business_name: "Brook Street Heating",
      trade: "heating_engineer",
      status: "onboarding",
      onboarding_state: "terms_accepted",
      notification_mobile: "+447700900555",
      // No separate address given: emails go to the one they signed in with.
      notification_email: person.email,
      contact_name: "Alex",
      mobile_network: "o2",
      uses_network_voicemail: true,
      is_test: false,
    });
    const acceptances = await admin.query<{ document_type: string; document_version: string }>(
      "SELECT document_type, document_version FROM terms_acceptances WHERE tenant_id = $1 ORDER BY document_type",
      [tenantId],
    );
    expect(acceptances.rows).toEqual([
      { document_type: "dpa", document_version: ACCEPTED.dpa },
      { document_type: "privacy_notice", document_version: ACCEPTED.privacy_notice },
      { document_type: "terms", document_version: ACCEPTED.terms },
    ]);

    // They're the owner straight away: no invitation to claim.
    const me = (await (await call("GET", "/me", undefined, person.token)).json()) as MeView;
    expect(me).toMatchObject({ role: "owner", tenantIds: [tenantId] });

    // The link is spent.
    expect(await linkStatus(code)).toBe(410);
    const second = await call("POST", "/signup", form(code), newcomer().token);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "This signup link has already been used" });
  });

  it("marks a business from a test link as a test business", async () => {
    const { code } = await newLink(tokens.admin, true);
    const response = await call("POST", "/signup", form(code), newcomer().token);
    const { tenantId } = (await response.json()) as SignupResultView;
    const row = await admin.query<{ is_test: boolean }>(
      "SELECT is_test FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(row.rows[0]!.is_test).toBe(true);
  });

  it("refuses, and leaves the link unused, for every problem it can spot", async () => {
    const { code } = await newLink();
    const refused = async (body: unknown, token: string, status: number) => {
      const response = await call("POST", "/signup", body, token);
      expect(response.status).toBe(status);
      return (await response.json()) as { error: string; issues?: Record<string, string[]> };
    };

    // Documents that changed since the page opened.
    const stale = { ...form(code), accepted: { ...ACCEPTED, terms: "an-older-version" } };
    expect((await refused(stale, newcomer().token, 409)).error).toMatch(/documents have changed/);
    // Someone who already has an account.
    expect((await refused(form(code), tokens.owner, 409)).error).toMatch(
      /already have an AnswerMate account/,
    );
    // An address the login provider hasn't verified.
    expect((await refused(form(code), newcomer(false).token, 403)).error).toMatch(
      /needs verifying/,
    );
    // A form that doesn't pass the rules.
    const bad = { ...form(code), mobile: "07700", accepted: { ...ACCEPTED, dpa: "" } };
    expect(Object.keys((await refused(bad, newcomer().token, 400)).issues ?? {}).sort()).toEqual([
      "accepted",
      "mobile",
    ]);
    expect(await linkStatus(code)).toBe(200);

    // And an expired one.
    const hash = createHash("sha256").update(code).digest("hex");
    await admin.query(
      "UPDATE signup_links SET expires_at = now() - interval '1 minute' WHERE code_hash = $1",
      [hash],
    );
    expect((await refused(form(code), newcomer().token, 409)).error).toMatch(/expired/);
    expect(await linkStatus(code)).toBe(410);

    // A bad link is turned down before the login provider is asked anything, so a stream of
    // them can't use up our allowance there.
    const lookups = auth.emailLookups;
    expect((await refused(form(randomUUID()), newcomer().token, 409)).error).toMatch(/isn't valid/);
    expect(auth.emailLookups).toBe(lookups);
  });
});
