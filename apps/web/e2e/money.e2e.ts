// The money screens, checked figure by figure against the seeded month (e2e-server.ts): Fern
// Lane Plumbing went live ten days ago and has used 12,630 seconds, which is 211 minutes, 11
// over the 200 included. So its bill so far is £99.00 + 11 x 20p = £101.20, and at that rate
// (day 10) the month is heading well past the plan.
//
// Set MONEY_SHOTS to a folder to keep a picture of each screen, light and dark.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, FERN_LANE, OWNER, apiAs, openAs, settled, tenantIdOf } from "./support.ts";

async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.MONEY_SHOTS;
  if (folder) await page.screenshot({ path: `${folder}/${name}.png`, fullPage: true });
}

test.describe("the Account page's month so far", () => {
  test("shows the bill in its two parts, the minutes, and where the month is heading", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}/settings`);
    await settled(page);
    const card = page.locator("#billing");

    await expect(card.getByRole("heading", { name: "This month so far" })).toBeVisible();
    await expect(card.locator(".hero-figure")).toHaveText("£101.20");
    await expect(card).toContainText(
      "£99.00 for the plan, plus £2.20 for 11 minutes over the included ones.",
    );
    // The bar says the same in words, for anyone who can't see its colours.
    await expect(
      card.getByRole("img", {
        name: "This month's bill so far: Plan £99.00, Extra minutes £2.20",
      }),
    ).toBeVisible();
    await expect(card).toContainText("211 of 200 included minutes used");
    await expect(card).toContainText("11 minutes over, at 20p each");
    await expect(
      card.getByRole("img", {
        name: "Minutes used this month: Included 200 minutes, Extra 11 minutes",
      }),
    ).toBeVisible();
    // Day 10 of the month: 12,630 s x days in the month / 10, so it depends on the month's
    // length; whatever it is, it's past the plan, and says so in pounds.
    await expect(card).toContainText(/At this rate: about \d+ minutes by .+, so about £\d+\.\d\d/);

    // Ten days of columns, each one named, and the same figures as a table.
    const columns = card.getByRole("list", { name: "Call minutes each day this month" });
    await expect(columns.getByRole("listitem")).toHaveCount(10);
    await card.getByText("Show as a table").click();
    await expect(card.getByRole("columnheader", { name: "Call time" })).toBeVisible();
    await shot(page, "account-light");
  });

  test("what the page shows is what the API worked out", async ({ request }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    const billing = await apiAs<{
      period: {
        feePence: number;
        billableSeconds: number;
        soFar: { overageMinutes: number; overagePence: number; totalPence: number };
        projected: { minutes: number; totalPence: number } | null;
        days: { date: string; billableSeconds: number }[];
      } | null;
    }>(request, OWNER, "GET", `/tenants/${fern}/billing`);
    expect(billing.period).toMatchObject({
      feePence: 9900,
      billableSeconds: 12630,
      soFar: { overageMinutes: 11, overagePence: 220, totalPence: 10120 },
    });
    expect(billing.period?.days).toHaveLength(10);
    expect(billing.period?.projected?.minutes).toBeGreaterThan(600);
  });
});

test.describe("the Admin page's costs", () => {
  test("shows the headline figures, every supplier with its tiers, and each business's bill", async ({
    page,
  }) => {
    await openAs(page, ADMIN, "/admin/usage");
    await settled(page);

    await expect(page.getByRole("heading", { name: "Costs at a glance" })).toBeVisible();
    for (const label of [
      "Costs, last 30 days",
      "Heading for, next 30 days",
      "Income, billing months so far",
      "Income less costs",
      "Cost of a call minute",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    // One paying business, at its bill so far.
    const income = page.locator(".stat", { hasText: "Income, billing months so far" });
    await expect(income.locator(".stat-value")).toHaveText("£101.20");
    await expect(income).toContainText("1 paying business, before VAT");

    // Every supplier is a row, with its plan.
    const suppliers = page
      .locator(".card", { hasText: "Every supplier, its plan and its tiers" })
      .getByRole("table");
    for (const name of [
      "Retell AI",
      "Twilio",
      "Anthropic (Claude)",
      "Postmark",
      "GoCardless",
      "Microsoft Azure",
      "Clerk",
      "UptimeRobot",
      "Porkbun",
    ]) {
      await expect(suppliers.getByText(name, { exact: true })).toBeVisible();
    }
    const postmark = suppliers.locator("tbody tr", { hasText: "Postmark" });
    await expect(postmark).toContainText("Free");

    // Opening a supplier shows its tiers, with the current one marked.
    await postmark.getByText("Postmark", { exact: true }).click();
    const tiers = postmark.getByRole("list", { name: "Postmark tiers" });
    await expect(tiers.getByRole("listitem")).toHaveCount(4);
    await expect(tiers.locator('[data-current="true"]')).toContainText("Free (current)");
    await expect(tiers).toContainText("Basic 10,000");
    await expect(tiers).toContainText("£12.00 a month");

    // The database's connections are at their limit, which is a warning.
    const warnings = page.locator(".card", { hasText: "Tier changes on the way" });
    await expect(warnings).toContainText("Microsoft Azure: costs or limits ahead");
    await expect(warnings).toContainText("35 of the database's 35 connections");

    // Twilio's and Postmark's own figures (the test server's fixed ones), beside ours.
    const accounts = page.locator(".card", { hasText: "From your accounts" });
    await expect(accounts).toContainText("£1.51 by Twilio's own total");
    await expect(accounts.getByRole("cell", { name: "Inbound Local Calls" })).toBeVisible();
    await expect(accounts).toContainText("14 emails sent, against 6 in the 30 days before.");
    await expect(accounts).toContainText("Bounced: 1 (7.1%)");
    // The supplier rows use those figures, and say so.
    const twilio = suppliers.locator("tbody tr", { hasText: "Twilio" });
    await expect(twilio).toContainText("£1.51");
    await expect(twilio).toContainText("Its own figure");
    await expect(postmark).toContainText("Emails (Postmark's count): 14 of 100 emails");
    // 1 bounce in 14 is past half of Postmark's 10%: a warning.
    await expect(warnings).toContainText("1 of 14 emails bounced (7.1%)");

    // Growth, and each business beside its bill.
    await expect(page.getByRole("heading", { name: "How fast use is growing" })).toBeVisible();
    const businesses = page
      .locator(".card", { hasText: "Each business: its costs and its bill so far" })
      .getByRole("table");
    const fern = businesses.locator("tbody tr", { hasText: FERN_LANE });
    await expect(fern).toContainText("£101.20");
    await expect(businesses.locator("tbody tr", { hasText: "Other Sparks" })).toContainText(
      "Doesn't pay",
    );
    await shot(page, "admin-light");
  });

  test("the suppliers' figures add up to the totals shown", async ({ request }) => {
    const costs = await apiAs<{
      suppliers: {
        services: { pence: { now: number; next: number }; tiers: { current: boolean }[] }[];
        totals: { nowPence: number; nextPence: number; incomePence: number; marginPence: number };
      };
      tenants: { businessName: string; billPence: number | null }[];
    }>(request, ADMIN, "GET", "/admin/costs");
    const { services, totals } = costs.suppliers;
    expect(services.reduce((total, each) => total + each.pence.now, 0)).toBe(totals.nowPence);
    expect(services.reduce((total, each) => total + each.pence.next, 0)).toBe(totals.nextPence);
    expect(totals.marginPence).toBe(totals.incomePence - totals.nowPence);
    expect(totals.incomePence).toBe(
      costs.tenants.reduce((total, each) => total + (each.billPence ?? 0), 0),
    );
    for (const each of services) {
      expect(each.tiers.filter((tier) => tier.current)).toHaveLength(1);
    }
    expect(costs.tenants.find((each) => each.businessName === FERN_LANE)?.billPence).toBe(10120);
  });

  test("both screens in dark mode", async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}/settings`);
    await settled(page);
    await expect(page.locator("#billing .hero-figure")).toHaveText("£101.20");
    await shot(page, "account-dark");
    await openAs(page, ADMIN, "/admin/usage");
    await settled(page);
    await expect(page.getByRole("heading", { name: "Costs at a glance" })).toBeVisible();
    await shot(page, "admin-dark");
  });
});
