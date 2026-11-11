// Every table that holds a business's data, one by one (CLAUDE.md: every tenant table has
// row-level security; a business can export everything we hold and have it deleted).
//
// The other tests check RLS on a table or two, the export's main parts, and the deletion's
// main tables. This file seeds a row in EVERY tenant table, for two businesses, and then:
//   - as the app role, checks each table shows a business only its own rows, and that it can't
//     change, delete or take over another business's rows;
//   - checks the export holds each table it should, and nothing of another business;
//   - checks the deletion empties each table it should, keeps each one it should, and leaves
//     no personal detail of the business behind anywhere.
// The tables are read from the database's catalog, so a new tenant table fails this file until
// it's seeded here and given a place in each list: exported or not, deleted or kept, and why.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createAdminPool, deleteTenantData } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";
import { exportTenant, exportTenantCsv } from "./tenant-settings.ts";
import {
  TEST_ADMIN_DATABASE_URL,
  TEST_DATABASE_URL,
  TEST_MIGRATION_DATABASE_URL,
} from "../testing/databases.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
// The migration owner: the only role that can write every table (row-level security still
// applies to it, so each write sets the business first, as testing/fixtures.ts does).
const owner = createPool(TEST_MIGRATION_DATABASE_URL.replace("?sslmode=disable", ""));

afterAll(async () => {
  await Promise.all([app.end(), admin.end(), owner.end()]);
});

/** Three random digits, for numbers in Ofcom's drama ranges that other runs won't share. */
const digits = () => String(Math.floor(Math.random() * 1000)).padStart(3, "0");
const hex = () => randomBytes(16).toString("hex");
/** Each business gets its own postcode district, so one business's can't pass for another's. */
let district = 10;

/** One business with a row in every tenant table, and the personal details in those rows. */
interface Seeded {
  tenantId: string;
  userId: string;
  callId: string;
  /** Strings that identify a person: none may survive the business's deletion. */
  personal: string[];
  /** Our IDs and provider references that must stay out of the export (ours, not theirs). */
  internal: string[];
}

/** The tables seedBusiness writes, in the order it writes them. */
const SEEDED_TABLES = [
  "tenants",
  "tenant_memberships",
  "phone_numbers",
  "agent_profiles",
  "calls",
  "call_costs",
  "notifications",
  "usage_periods",
  "terms_acceptances",
  "audit_log",
  "blocked_numbers",
  "signup_links",
  "onboarding_texts",
  "offboarding_messages",
  "payment_mandates",
  "payment_events",
  "billing_charges",
  "billing_emails",
  "tenant_suspensions",
] as const;
type TenantTable = (typeof SEEDED_TABLES)[number];

async function seedBusiness(label: string): Promise<Seeded> {
  const tenantId = randomUUID();
  const callId = randomUUID();
  const mobile = `+447700900${digits()}`;
  const caller = `+447700900${digits()}`;
  const blocked = `+441134960${digits()}`;
  const ownerEmail = `owner-${randomUUID()}@example.com`;
  const notifyEmail = `notify-${randomUUID()}@example.com`;
  // Made-up words that appear nowhere else, so finding one after deletion means a leak.
  const contactName = `Quillon${label}`;
  const callerName = `Varrick${label}`;
  const postcode = `XQ${district++} 9ZZ`;
  const summaryWords = `zephyrine leak ${label}`;
  const transcriptWords = `marrowfield ceiling ${label}`;
  const recordingRef = `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${hex()}`;
  const agentId = `agent_${hex()}`;
  const authSubject = `sub_${randomUUID()}`;
  const paymentEventId = `EV${hex()}`;
  const paymentRef = `PM${hex()}`;
  const billingEmailRef = `ref_${hex()}`;
  const billingEmailProviderRef = `email_${hex()}`;

  const client = await owner.connect();
  let userId = "";
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    userId = (
      await client.query<{ id: string }>(
        "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, 'owner') RETURNING id",
        [authSubject, ownerEmail],
      )
    ).rows[0]!.id;
    const write: Record<TenantTable, () => Promise<unknown>> = {
      tenants: () =>
        client.query(
          `INSERT INTO tenants (id, business_name, trade, contact_name, notification_mobile,
                                notification_email, mobile_network, voicemail_restore_code)
           VALUES ($1, $2, 'plumber', $3, $4, $5, 'o2', $6)`,
          [
            tenantId,
            `Every Table ${label} Plumbing`,
            contactName,
            mobile,
            notifyEmail,
            // A restore code with the person's own mobile in it, as some networks' codes are.
            `**61*${mobile}#`,
          ],
        ),
      tenant_memberships: () =>
        client.query("INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2)", [
          tenantId,
          userId,
        ]),
      // Released, so the "one active number" indexes can't collide with another file's.
      phone_numbers: () =>
        client.query(
          `INSERT INTO phone_numbers (tenant_id, number, provider_sid, status, released_at)
           VALUES ($1, $2, $3, 'released', now())`,
          [tenantId, `+441134960${digits()}`, `PN${hex()}`],
        ),
      agent_profiles: () =>
        client.query(
          `INSERT INTO agent_profiles (tenant_id, version, trade_template, services, faqs, provider_agent_id)
           VALUES ($1, 1, 'plumber', '["Boilers"]', $2, $3)`,
          [
            tenantId,
            JSON.stringify([{ question: "Who?", answer: `Ask for ${contactName}` }]),
            agentId,
          ],
        ),
      calls: () =>
        client.query(
          `INSERT INTO calls (id, tenant_id, provider_call_id, caller_number, started_at, ended_at,
                              summary, transcript, extracted_fields, recording_ref)
           VALUES ($1, $2, $3, $4, now(), now(), $5, $6, $7, $8)`,
          [
            callId,
            tenantId,
            `call_${hex()}`,
            caller,
            summaryWords,
            `caller: ${transcriptWords} at ${postcode}`,
            { callerName, callbackNumber: caller, postcode },
            recordingRef,
          ],
        ),
      call_costs: () =>
        client.query(
          `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
           VALUES ($1, $2, 'llm:tokens', 10, 'tokens', false)`,
          [tenantId, callId],
        ),
      notifications: () =>
        client.query(
          `INSERT INTO notifications (tenant_id, call_id, channel, status, attempts, provider_ref, failure_reason)
           VALUES ($1, $2, 'sms', 'failed', 1, $3, $4)`,
          [tenantId, callId, `SM${hex()}`, `Twilio refused ${mobile}`],
        ),
      usage_periods: () =>
        client.query(
          `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
           VALUES ($1, '2026-10-01', '2026-11-01', 60)`,
          [tenantId],
        ),
      terms_acceptances: () =>
        client.query(
          `INSERT INTO terms_acceptances (tenant_id, document_type, document_version, accepted_by)
           VALUES ($1, 'terms', 'v1', $2)`,
          [tenantId, userId],
        ),
      audit_log: () =>
        client.query(
          `INSERT INTO audit_log (tenant_id, actor_user_id, action, details)
           VALUES ($1, $2, 'notifications.changed', '{"via":"dashboard","changed":["notificationMobile"]}')`,
          [tenantId, userId],
        ),
      blocked_numbers: () =>
        client.query(
          "INSERT INTO blocked_numbers (tenant_id, number, reason) VALUES ($1, $2, 'nuisance')",
          [tenantId, blocked],
        ),
      signup_links: () =>
        client.query(
          `INSERT INTO signup_links (code_hash, created_by, expires_at, used_at, tenant_id)
           VALUES ($1, $2, now() + interval '1 day', now(), $3)`,
          [hex(), userId, tenantId],
        ),
      onboarding_texts: () =>
        client.query(
          `INSERT INTO onboarding_texts (tenant_id, kind, status, provider_ref)
           VALUES ($1, 'divert_instructions', 'sent', $2)`,
          [tenantId, `SM${hex()}`],
        ),
      offboarding_messages: () =>
        client.query(
          `INSERT INTO offboarding_messages (tenant_id, kind, channel, status, provider_ref)
           VALUES ($1, 'cancellation', 'sms', 'sent', $2)`,
          [tenantId, `SM${hex()}`],
        ),
      payment_mandates: () =>
        client.query(
          `INSERT INTO payment_mandates (tenant_id, setup_ref, authorisation_url, expires_at, status)
           VALUES ($1, $2, 'https://pay.fake.invalid/setup', now() + interval '1 day', 'pending')`,
          [tenantId, `BRQ${hex()}`],
        ),
      payment_events: () =>
        client.query(
          `INSERT INTO payment_events (event_id, tenant_id, resource_type, action, resource_ref)
           VALUES ($1, $2, 'payments', 'confirmed', $3)`,
          [paymentEventId, tenantId, paymentRef],
        ),
      billing_charges: () =>
        client.query(
          `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
             billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
             vat_pence, total_pence, lines, status)
           VALUES ($1, '2026-10-01', '2026-11-01', 0, 60, 9900, 0, 0, 0, 0, 9900, '[]', 'paid_out')`,
          [tenantId],
        ),
      billing_emails: () =>
        client.query(
          `INSERT INTO billing_emails (tenant_id, kind, ref, status, provider_ref)
           VALUES ($1, 'receipt', $2, 'sent', $3)`,
          [tenantId, billingEmailRef, billingEmailProviderRef],
        ),
      tenant_suspensions: () =>
        client.query(
          `INSERT INTO tenant_suspensions (tenant_id, started_at, ended_at)
           VALUES ($1, now() - interval '2 days', now() - interval '1 day')`,
          [tenantId],
        ),
    };
    for (const table of SEEDED_TABLES) await write[table]();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    tenantId,
    userId,
    callId,
    personal: [
      mobile,
      caller,
      blocked,
      ownerEmail,
      notifyEmail,
      contactName,
      callerName,
      postcode,
      summaryWords,
      transcriptWords,
    ],
    // Our IDs and the providers' references, including the person's login subject and the
    // references on the payment events and billing emails the export now carries.
    internal: [
      recordingRef,
      agentId,
      userId,
      authSubject,
      paymentEventId,
      paymentRef,
      billingEmailRef,
      billingEmailProviderRef,
    ],
  };
}

/** Every table in the public schema with a tenant_id column, plus tenants itself. */
async function tenantTablesInCatalog(): Promise<string[]> {
  const { rows } = await admin.query<{ name: string }>(`
    SELECT c.relname AS name FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      AND (c.relname = 'tenants' OR EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
    ORDER BY 1`);
  return rows.map((row) => row.name);
}

/** The column that says whose a row is. */
const ownerColumn = (table: string) => (table === "tenants" ? "id" : "tenant_id");

/** How many rows a business has in a table, counted across tenants by the admin role. */
async function countFor(table: string, tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${ownerColumn(table)} = $1`,
    [tenantId],
  );
  return rows[0]!.n;
}

/** A statement's row count, or "denied" when the app role has no grant for it at all. */
async function rowsOrDenied(run: () => Promise<pg.QueryResult>): Promise<number | "denied"> {
  try {
    return (await run()).rowCount ?? 0;
  } catch (error) {
    if ((error as { code?: string }).code === "42501") return "denied";
    throw error;
  }
}

describe("the seed covers every tenant table", () => {
  it("writes a row to each table the catalog says holds a business's data", async () => {
    // A new tenant table must be added to SEEDED_TABLES and to the lists below, which makes
    // whoever adds it decide whether it's exported and whether a deletion removes it.
    expect([...SEEDED_TABLES].sort()).toEqual(await tenantTablesInCatalog());
  });
});

describe("row-level security, table by table, as the app role", () => {
  let a: Seeded;
  let b: Seeded;
  const before = new Map<string, number>();

  beforeAll(async () => {
    a = await seedBusiness("RlsA");
    b = await seedBusiness("RlsB");
    for (const table of SEEDED_TABLES) before.set(table, await countFor(table, b.tenantId));
  });

  it("shows nothing at all with no business set", async () => {
    for (const table of SEEDED_TABLES) {
      const seen = await rowsOrDenied(() => app.query(`SELECT 1 FROM ${table}`));
      expect(seen, table).toSatisfy((n: number | "denied") => n === 0 || n === "denied");
    }
  });

  it("shows a business its own rows in every table it can read, and only those", async () => {
    for (const table of SEEDED_TABLES) {
      const column = ownerColumn(table);
      const owners = await withTenant(app, a.tenantId, (client) =>
        client
          .query<{ owner: string }>(`SELECT ${column} AS owner FROM ${table}`)
          .then((result) => result.rows.map((row) => row.owner))
          .catch((error: { code?: string }) => {
            if (error.code === "42501") return null;
            throw error;
          }),
      );
      if (owners === null) continue; // No read grant: the app role never reads this table.
      expect(owners.length, `${table} shows the business its own row`).toBeGreaterThan(0);
      expect(new Set(owners), table).toEqual(new Set([a.tenantId]));
    }
  });

  it("never lets a business change or delete another business's rows", async () => {
    for (const table of SEEDED_TABLES) {
      const column = ownerColumn(table);
      const updated = await rowsOrDenied(() =>
        withTenant(app, a.tenantId, (client) =>
          client.query(`UPDATE ${table} SET ${column} = ${column} WHERE ${column} = $1`, [
            b.tenantId,
          ]),
        ),
      );
      expect(updated, `UPDATE ${table}`).toSatisfy(
        (n: number | "denied") => n === 0 || n === "denied",
      );
      const deleted = await rowsOrDenied(() =>
        withTenant(app, a.tenantId, (client) =>
          client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [b.tenantId]),
        ),
      );
      expect(deleted, `DELETE ${table}`).toSatisfy(
        (n: number | "denied") => n === 0 || n === "denied",
      );
    }
    for (const table of SEEDED_TABLES) {
      expect(await countFor(table, b.tenantId), table).toBe(before.get(table));
    }
  });

  it("never lets a business hand one of its own rows to another business", async () => {
    // The policy's check applies to the new row: moving a row across is refused outright,
    // by the policy or by a missing grant, never silently done.
    for (const table of SEEDED_TABLES) {
      const column = ownerColumn(table);
      await expect(
        withTenant(app, a.tenantId, (client) =>
          client.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [
            a.tenantId,
            b.tenantId,
          ]),
        ),
        table,
      ).rejects.toMatchObject({ code: "42501" });
    }
    for (const table of SEEDED_TABLES) {
      expect(await countFor(table, b.tenantId), table).toBe(before.get(table));
    }
  });

  it("never lets a business see another's rows by asking for them by ID", async () => {
    const found = await withTenant(app, a.tenantId, async (client) => ({
      call: (await client.query("SELECT 1 FROM calls WHERE id = $1", [b.callId])).rowCount,
      tenant: (await client.query("SELECT 1 FROM tenants WHERE id = $1", [b.tenantId])).rowCount,
      costs: (await client.query("SELECT 1 FROM call_costs WHERE call_id = $1", [b.callId]))
        .rowCount,
      sent: (await client.query("SELECT 1 FROM notifications WHERE call_id = $1", [b.callId]))
        .rowCount,
    }));
    expect(found).toEqual({ call: 0, tenant: 0, costs: 0, sent: 0 });
  });
});

describe("the data export (BUILD_PLAN Step 13)", () => {
  /** Where each exported table lands in the export. */
  const EXPORTED: Partial<Record<TenantTable, string>> = {
    tenants: "tenant",
    agent_profiles: "agentProfiles",
    calls: "calls",
    notifications: "notifications",
    audit_log: "auditLog",
    phone_numbers: "phoneNumbers",
    terms_acceptances: "termsAcceptances",
    usage_periods: "usagePeriods",
    blocked_numbers: "blockedNumbers",
    onboarding_texts: "onboardingTexts",
    offboarding_messages: "offboardingMessages",
    billing_charges: "billingCharges",
    payment_mandates: "directDebits",
    // Phil's answer to the open questions (2026-11-11): these are about the business, so the
    // export carries them. The people by email and role only (through tenant_members()).
    tenant_memberships: "peopleWithAccess",
    payment_events: "paymentEvents",
    billing_emails: "billingEmails",
    tenant_suspensions: "suspensions",
  };
  /** Left out on purpose, and why. */
  const NOT_EXPORTED: Partial<Record<TenantTable, string>> = {
    call_costs: "what each call cost us to serve: our records, not theirs",
    signup_links: "an internal record of the link that created the business",
  };

  let a: Seeded;
  let b: Seeded;
  beforeAll(async () => {
    a = await seedBusiness("ExportA");
    b = await seedBusiness("ExportB");
  });

  it("gives every tenant table a place: exported, or left out with a reason", () => {
    for (const table of SEEDED_TABLES) {
      const placed = (table in EXPORTED ? 1 : 0) + (table in NOT_EXPORTED ? 1 : 0);
      expect(placed, table).toBe(1);
    }
  });

  it("holds the business's row from every exported table", async () => {
    const data = (await exportTenant(app, a.tenantId)) as Record<string, unknown>;
    for (const [table, key] of Object.entries(EXPORTED)) {
      const value = data[key];
      if (table === "tenants") {
        expect(value, key).toMatchObject({ id: a.tenantId });
      } else {
        expect(Array.isArray(value) && value.length > 0, `${table} → ${key}`).toBe(true);
      }
    }
  });

  it("holds nothing of any other business, and none of the providers' references", async () => {
    const text = JSON.stringify(await exportTenant(app, a.tenantId));
    expect(text).not.toContain(b.tenantId);
    expect(text).not.toContain(b.callId);
    for (const value of b.personal) expect(text, value).not.toContain(value);
    for (const value of [...a.internal, ...b.internal]) expect(text, value).not.toContain(value);
    // And it is the business's own: its caller and its summary are there.
    expect(text).toContain(a.personal[1]);
    expect(text).toContain(a.personal[8]);
  });

  it("names the people with access by email and role only: no IDs, no login subjects", async () => {
    const people = (await exportTenant(app, a.tenantId)).peopleWithAccess as Record<
      string,
      unknown
    >[];
    expect(people).toHaveLength(1);
    expect(Object.keys(people[0]!).sort()).toEqual(["added_at", "email", "role"]);
    expect(people[0]).toMatchObject({ email: a.personal[3], role: "owner" });
    expect(people[0]!["added_at"]).toBeInstanceOf(Date);
  });

  it("answers the people lookup only for the business the transaction is set to", async () => {
    // tenant_members() runs as the owner, past row-level security, so it checks the business
    // itself: asked about another one, or with none set, it has nothing to say.
    const asked = await withTenant(app, a.tenantId, async (client) => ({
      own: (await client.query("SELECT email FROM tenant_members($1)", [a.tenantId])).rowCount,
      other: (await client.query("SELECT email FROM tenant_members($1)", [b.tenantId])).rowCount,
    }));
    expect(asked).toEqual({ own: 1, other: 0 });
    expect((await app.query("SELECT email FROM tenant_members($1)", [a.tenantId])).rowCount).toBe(
      0,
    );
  });

  it("gives the newly exported tables a CSV each, holding the same rows as the file", async () => {
    for (const table of ["people", "payment-events", "billing-emails", "suspensions"] as const) {
      const lines = (await exportTenantCsv(app, a.tenantId, table)).split("\r\n").filter(Boolean);
      expect(lines, table).toHaveLength(2); // the header and the business's one row
    }
    const people = await exportTenantCsv(app, a.tenantId, "people");
    expect(people).toContain(a.personal[3]);
    expect(people).not.toContain(b.personal[3]);
    expect(people).not.toContain(a.userId);
  });

  it("exports nothing for a business ID that isn't one", async () => {
    const data = await exportTenant(app, randomUUID());
    expect(data.tenant).toBeNull();
    expect(data.calls).toEqual([]);
    expect(data.auditLog).toEqual([]);
  });
});

describe("deleting a business's data (BUILD_PLAN Step 13)", () => {
  /** Emptied by the deletion. */
  const DELETED: TenantTable[] = [
    "calls",
    "call_costs",
    "notifications",
    "agent_profiles",
    "blocked_numbers",
    "onboarding_texts",
    "offboarding_messages",
    "tenant_memberships",
  ];
  /** Kept, and why (cross-tenant.ts deleteTenantData says the same). */
  const KEPT: Partial<Record<TenantTable, string>> = {
    tenants: "anonymised: the billing and legal records hang off it",
    phone_numbers: "our numbers, not personal data",
    usage_periods: "the billing record",
    billing_charges: "the billing record",
    billing_emails: "the billing record: kinds and references, no addresses",
    payment_mandates: "the Direct Debit's history, with no bank details",
    payment_events: "the payment provider's events, with no personal details",
    tenant_suspensions: "dates only",
    terms_acceptances: "append-only legal record (the person is anonymised)",
    audit_log: "append-only record, which holds no contact details",
    signup_links: "a hash and dates",
  };

  let gone: Seeded;
  let staying: Seeded;
  const keptBefore = new Map<string, number>();
  const stayingBefore = new Map<string, number>();

  beforeAll(async () => {
    gone = await seedBusiness("GoneA");
    staying = await seedBusiness("StayB");
    for (const table of SEEDED_TABLES) {
      keptBefore.set(table, await countFor(table, gone.tenantId));
      stayingBefore.set(table, await countFor(table, staying.tenantId));
    }
    await deleteTenantData(admin, gone.tenantId, {
      now: new Date("2026-11-11T12:00:00Z"),
      actorUserId: null,
    });
  });

  it("gives every tenant table a place: deleted, or kept with a reason", () => {
    for (const table of SEEDED_TABLES) {
      const placed = (DELETED.includes(table) ? 1 : 0) + (table in KEPT ? 1 : 0);
      expect(placed, table).toBe(1);
    }
  });

  it("empties every table it should", async () => {
    for (const table of DELETED) expect(await countFor(table, gone.tenantId), table).toBe(0);
  });

  it("keeps every table it should, row for row", async () => {
    for (const table of Object.keys(KEPT)) {
      // The deletion adds its own audit row; nothing else in the kept tables changes.
      const extra = table === "audit_log" ? 1 : 0;
      expect(await countFor(table, gone.tenantId), table).toBe(keptBefore.get(table)! + extra);
    }
  });

  it("leaves no personal detail of the business in any row it keeps", async () => {
    for (const table of SEEDED_TABLES) {
      const { rows } = await admin.query<{ row: string }>(
        `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE ${ownerColumn(table)} = $1`,
        [gone.tenantId],
      );
      const text = rows.map((row) => row.row).join("\n");
      for (const value of gone.personal) expect(text, `${value} in ${table}`).not.toContain(value);
    }
    const person = (
      await admin.query<{ email: string; auth_subject: string | null }>(
        "SELECT email, auth_subject FROM users WHERE id = $1",
        [gone.userId],
      )
    ).rows[0]!;
    expect(person).toEqual({
      email: `deleted-${gone.userId}@deleted.invalid`,
      auth_subject: null,
    });
  });

  it("touches nothing of any other business", async () => {
    for (const table of SEEDED_TABLES) {
      expect(await countFor(table, staying.tenantId), table).toBe(stayingBefore.get(table));
    }
    const { rows } = await admin.query<{ business_name: string; notification_mobile: string }>(
      "SELECT business_name, notification_mobile FROM tenants WHERE id = $1",
      [staying.tenantId],
    );
    expect(rows[0]).toEqual({
      business_name: "Every Table StayB Plumbing",
      notification_mobile: staying.personal[0],
    });
  });
});
