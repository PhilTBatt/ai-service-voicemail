import { afterAll, describe, expect, it, vi } from "vitest";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeEmailProvider } from "../providers/email.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { runBillingEmail, type BillingEmailDeps } from "./billing-email.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const ADDRESS = "receipts@example.com";

async function chargedBusiness(email: string | null = ADDRESS) {
  const tenantId = await createTenant(admin, {
    businessName: "Receipt Plumbing",
    trade: "plumber",
    ...(email !== null && { notificationEmail: email }),
  });
  // Written as the charging run writes it: inside the business's own scope.
  const chargeId = await withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
             billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
             vat_pence, total_pence, lines, status, payment_ref, charge_date)
           VALUES ($1, '2026-06-14', '2026-07-14', 0, 60, 9900, 0, 0, 0, 0, 9900,
                   '[{"description":"AI Answering plan","pence":9900}]', 'pending', $2, '2026-07-19')
           RETURNING id`,
          [tenantId, `PM${tenantId.replace(/-/g, "")}`],
        )
      ).rows[0]!.id,
  );
  return { tenantId, chargeId };
}

function deps(allow: string[] = [ADDRESS]): BillingEmailDeps & { email: FakeEmailProvider } {
  return {
    pool: app,
    email: new FakeEmailProvider(),
    outbound: { nodeEnv: "test", allowlist: new Set(allow) },
    dashboardOrigin: "https://dash.example",
  };
}

describe("runBillingEmail", () => {
  it("sends a month's receipt once", async () => {
    const { tenantId, chargeId } = await chargedBusiness();
    const d = deps();
    expect(await runBillingEmail(d, { tenantId, kind: "receipt", ref: chargeId })).toBe("sent");
    expect(await runBillingEmail(d, { tenantId, kind: "receipt", ref: chargeId })).toBe(
      "already-sent",
    );
    expect(d.email.sent).toHaveLength(1);
    expect(d.email.sent[0]).toMatchObject({
      to: ADDRESS,
      subject: "Your AnswerMate receipt: 14 Jun 2026 to 13 Jul 2026",
    });
    expect(d.email.sent[0]?.text).toContain("Total: £99.00");
    expect(d.email.sent[0]?.text).toContain("on or soon after 19 Jul 2026");
  });

  it("links a business whose Direct Debit ended back to its Account tab", async () => {
    const { tenantId } = await chargedBusiness();
    const d = deps();
    expect(
      await runBillingEmail(d, { tenantId, kind: "direct_debit_ended", ref: "MD_ENDED" }),
    ).toBe("sent");
    expect(d.email.sent[0]?.text).toContain(
      `https://dash.example/tenants/${tenantId}/settings#billing`,
    );
  });

  it("stops, records and says so when the email provider refuses the address for good", async () => {
    const { tenantId, chargeId } = await chargedBusiness();
    const alert = vi.fn();
    const d = { ...deps(), alert };
    d.email.willFail(
      Object.assign(new Error("Postmark /email failed: HTTP 422, error 406: inactive recipient"), {
        status: 422,
      }),
    );
    expect(await runBillingEmail(d, { tenantId, kind: "receipt", ref: chargeId })).toBe("refused");
    expect(await runBillingEmail(d, { tenantId, kind: "receipt", ref: chargeId })).toBe(
      "already-sent",
    );
    expect(alert).toHaveBeenCalledWith(
      "notification-refused",
      expect.objectContaining({ tenantId, channel: "billing:receipt" }),
    );
  });

  it("never sends outside the allowlist, and records a business with no email", async () => {
    const blocked = await chargedBusiness("someone-else@example.com");
    const d = deps();
    expect(
      await runBillingEmail(d, {
        tenantId: blocked.tenantId,
        kind: "receipt",
        ref: blocked.chargeId,
      }),
    ).toBe("blocked");
    const none = await chargedBusiness(null);
    expect(
      await runBillingEmail(d, {
        tenantId: none.tenantId,
        kind: "payment_failed",
        ref: none.chargeId,
      }),
    ).toBe("no-email");
    expect(d.email.sent).toHaveLength(0);
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM billing_emails WHERE tenant_id IN ($1, $2) ORDER BY status",
      [blocked.tenantId, none.tenantId],
    );
    expect(rows.map((row) => row.status)).toEqual(["blocked", "no_email"]);
  });
});
