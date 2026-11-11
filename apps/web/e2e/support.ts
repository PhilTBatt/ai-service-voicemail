// Shared steps for the browser tests that came after the smoke tests (journeys, numbers, pages).
// Not a test file itself: playwright.config.ts only runs *.e2e.ts.
//
// The tests share one seeded database (apps/api/src/testing/e2e-server.ts) and run one at a
// time, in file order: journeys.e2e.ts, numbers.e2e.ts, pages.e2e.ts, then smoke.e2e.ts. So a
// test either puts back what it changed (in an afterEach hook, through the API, so a failure
// halfway can't leave the seeded business switched off for every test after it) or changes a
// business of its own, made through a fresh signup link. A hook, not a `finally`: once a test
// has run out of time, Playwright has closed its request before a `finally` runs, but hooks
// still get one.
import type { CallListView, CreatedSignupLinkView, TenantListView } from "@callmate/shared";
import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

export const ADMIN = "admin@example.com";
export const OWNER = "owner@example.com";
export const FERN_LANE = "Fern Lane Plumbing";
export const OTHER_SPARKS = "Other Sparks";

/**
 * The header that has the test API buy numbers from its stand-in for Twilio: "on", or
 * "switched-off" for a server with TWILIO_PURCHASES_ENABLED off. Without it the API has no
 * number buying at all. Named in apps/api/src/testing/e2e-server.ts too, which reads it.
 */
export const NUMBERS_HEADER = "x-e2e-numbers";

/** The token the sign-in stand-in stores (src/testing/clerk-stub.tsx), and the API reads. */
function tokenFor(email: string): string {
  return Buffer.from(JSON.stringify({ subject: `e2e_${email}`, email })).toString("base64");
}

/**
 * Signs in as someone and opens a page. Straight into the stand-in's storage rather than
 * through its form: the smoke tests cover the form, and this way a test starts on the page it
 * is about, with no reload to race.
 */
export async function openAs(page: Page, email: string, path: string): Promise<void> {
  await page.goto("/favicon.svg"); // any page of the dashboard's site, to reach its storage
  await page.evaluate(([key, token]) => window.localStorage.setItem(key, token), [
    "e2e-signed-in",
    tokenFor(email),
  ] as const);
  await page.goto(path);
}

/** Calls the API as someone and gives back whatever it answered, for checking a refusal. */
export function apiResponseAs(
  request: APIRequestContext,
  email: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<APIResponse> {
  return request.fetch(`/api${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(email)}` },
    ...(body !== undefined && { data: body }),
  });
}

/** Calls the API as someone, for setting a test up or putting things back afterwards. */
export async function apiAs<T = unknown>(
  request: APIRequestContext,
  email: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await apiResponseAs(request, email, method, path, body);
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return (await response.json()) as T;
}

/** A business's id, by its name, as the admin sees the list. */
export async function tenantIdOf(request: APIRequestContext, name: string): Promise<string> {
  const { tenants } = await apiAs<TenantListView>(request, ADMIN, "GET", "/tenants");
  const tenant = tenants.find((t) => t.businessName === name);
  if (!tenant) throw new Error(`No business called ${name}`);
  return tenant.id;
}

/** The seeded call of a business, found by its summary. */
export async function callIdOf(
  request: APIRequestContext,
  tenantId: string,
  summary: string,
): Promise<string> {
  const { calls } = await apiAs<CallListView>(request, ADMIN, "GET", `/tenants/${tenantId}/calls`);
  const call = calls.find((c) => c.summary === summary);
  if (!call) throw new Error(`No call "${summary}"`);
  return call.callId;
}

/** A signup link's code, made by the admin (the smoke tests make one through the page). */
export async function newSignupCode(request: APIRequestContext): Promise<string> {
  const link = await apiAs<CreatedSignupLinkView>(request, ADMIN, "POST", "/signup-links", {
    forTest: true,
  });
  return link.code;
}

/** An address nobody has used yet in this run, and in a retry of it. */
export function freshEmail(who: string): string {
  return `${who}-${Date.now()}@example.com`;
}

/**
 * Signs a new business up through a fresh link, as a tradesperson would, and leaves them on
 * its Calls page. Returns its id. For tests that change a business: they change their own.
 */
export async function signUpBusiness(
  page: Page,
  request: APIRequestContext,
  { email, businessName }: { email: string; businessName: string },
): Promise<string> {
  const code = await newSignupCode(request);
  await openAs(page, email, `/signup?code=${code}`);
  await page.getByLabel("Business name").fill(businessName);
  await page.getByLabel("Trade", { exact: true }).selectOption("electrician");
  await page.getByLabel(/^Your name/).fill("Jo");
  await page.getByLabel(/^Mobile, for texts/).fill("07700 900321");
  await page.getByLabel(/^Mobile network/).selectOption("ee");
  await page.getByLabel("No", { exact: true }).check();
  await page.getByLabel("I accept the Terms of service").check();
  await page.getByLabel("I accept the Data processing agreement").check();
  await page.getByLabel("I accept the Privacy notice").check();
  await page.getByRole("button", { name: "Set up my business" }).click();
  await expect(page.getByRole("heading", { level: 1, name: businessName })).toBeVisible();
  const id = /\/tenants\/([0-9a-f-]+)$/.exec(new URL(page.url()).pathname)?.[1];
  if (!id) throw new Error(`Not on a business's page: ${page.url()}`);
  return id;
}

/** Waits until nothing on the page is still loading (Loading and busy buttons say aria-busy). */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/** The UK date today, as a date box holds it (YYYY-MM-DD), `days` on from today. */
export function ukDateFromToday(days: number): string {
  // en-CA writes dates as YYYY-MM-DD. Then calendar days are added, not 24 hours, which
  // would land on the wrong day near midnight on a clock-change weekend.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
