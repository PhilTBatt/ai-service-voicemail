// The "Your AnswerMate number" card on a business's Account page: the admin finding numbers and
// buying one. In production buying is a real purchase that costs money every month, so it waits
// for a confirmation, and the API refuses it to anyone but the admin, for a business that's
// leaving, and on a server with purchases switched off.
//
// The test API buys from a stand-in for Twilio (apps/api/src/testing/e2e-server.ts), never from
// Twilio itself, and only for requests that carry its numbers header, as every request from
// this file does. Each test signs up a business of its own, so the seeded ones keep the number
// they have (Fern Lane) and the lack of one (Other Sparks) the other files expect. The number
// bought here stays with its test business: releasing one needs 30 days of leaving first.
import type { AvailableNumbersView, TenantView } from "@callmate/shared";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  apiAs,
  apiResponseAs,
  freshEmail,
  NUMBERS_HEADER,
  openAs,
  signUpBusiness,
} from "./support.ts";

test.use({ extraHTTPHeaders: { [NUMBERS_HEADER]: "on" } });

const NUMBER_CARD = "Your AnswerMate number";

/** A card, by its heading: cards aren't landmarks, so they have no role of their own. */
function cardTitled(page: Page, title: string): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

/** A number as the dashboard writes it (01632960100), as the API stores it (+441632960100). */
function e164(national: string): string {
  return `+44${national.slice(1)}`;
}

/** The business's number, as the server has it. */
async function numberOf(request: APIRequestContext, tenantId: string): Promise<string | null> {
  return (await apiAs<TenantView>(request, ADMIN, "GET", `/tenants/${tenantId}`)).number;
}

test.describe("the admin", () => {
  test("finds numbers with and without an area code, buys nothing on Cancel, and buys once it's confirmed", async ({
    page,
    request,
  }) => {
    const id = await signUpBusiness(page, request, {
      email: freshEmail("kestrel"),
      businessName: "Kestrel Roofing",
    });
    await openAs(page, ADMIN, `/tenants/${id}/settings`);
    const card = cardTitled(page, NUMBER_CARD);
    const contains = card.getByLabel("Number contains");
    const find = card.getByRole("button", { name: "Find numbers" });
    const offers = card.getByRole("listitem");
    const leeds = offers.filter({ hasText: /^0113/ });
    const drama = offers.filter({ hasText: /^01632/ });
    await expect(card.getByText("No number yet.")).toBeVisible();

    // Nothing typed: every number on offer, each with what it costs a month, and buyable.
    await find.click();
    await expect(leeds).not.toHaveCount(0);
    await expect(drama).not.toHaveCount(0);
    await expect(leeds.first()).toContainText("Leeds");
    await expect(offers.first().getByRole("button", { name: "Buy (£0.87/month)" })).toBeEnabled();
    await expect(card.getByText(/Buying is switched off/)).toHaveCount(0);

    // An area code, spaced as people write it, leaves the others out.
    await contains.fill("01632 960");
    await find.click();
    await expect(leeds).toHaveCount(0);
    await expect(drama).not.toHaveCount(0);

    // Digits no number has: it says so, rather than showing an empty list.
    await contains.fill("0999");
    await find.click();
    await expect(card.getByText("No numbers match.")).toBeVisible();
    await expect(offers).toHaveCount(0);

    // The first number offered, whichever it is: a retry on the same server finds the one an
    // earlier try bought has gone, as at Twilio.
    await contains.fill("01632");
    await find.click();
    await expect(drama).not.toHaveCount(0);
    const offer = drama.first();
    const number = /^0\d{9,10}/.exec((await offer.textContent()) ?? "")?.[0];
    if (!number) throw new Error(`No number in "${await offer.textContent()}"`);
    const buy = offer.getByRole("button", { name: /^Buy/ });
    const question = page.getByRole("dialog", { name: `Buy ${number}?` });
    const cancel = question.getByRole("button", { name: "Cancel" });

    // The question says what it costs and that it's real, and spending money is dangerous, so
    // the keyboard starts on Cancel. Cancelling buys nothing: the number is still on offer.
    await buy.click();
    await expect(question).toContainText(
      "It costs £0.87 a month. This is a real purchase from Twilio, charged to the account straight away",
    );
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect(question).toHaveCount(0);
    await expect(buy).toBeFocused();
    await expect(card.getByText("No number yet.")).toBeVisible();
    expect(await numberOf(request, id)).toBeNull();
    const stillOffered = await apiAs<AvailableNumbersView>(
      request,
      ADMIN,
      "GET",
      "/admin/numbers/available?contains=01632",
    );
    expect(stillOffered.numbers.map((n) => n.number)).toContain(e164(number));

    // Confirmed, it's bought, and the card shows it in place of the search.
    await buy.click();
    await question.getByRole("button", { name: "Buy this number" }).click();
    await expect(question).toHaveCount(0);
    await expect(card.getByText(number, { exact: true })).toBeVisible();
    await expect(card.getByText("No number yet.")).toHaveCount(0);
    await expect(contains).toHaveCount(0);
    await expect(find).toHaveCount(0);
    // The server has it, not just the page.
    await page.reload();
    await expect(card.getByText(number, { exact: true })).toBeVisible();
    expect(await numberOf(request, id)).toBe(e164(number));

    // Phone setup shows it too, where the tradesperson needs it to divert their calls.
    await page.getByRole("link", { name: "Phone setup" }).click();
    const setup = cardTitled(page, "Send the calls you miss to AnswerMate");
    await expect(setup.getByText(number, { exact: true })).toBeVisible();
    await expect(page.getByText("Your AnswerMate number isn't ready yet")).toHaveCount(0);
  });
});

test.describe("a tradesperson", () => {
  test("sees there's no number yet, but nothing to search or buy with, and the API refuses them", async ({
    page,
    request,
  }) => {
    const owner = freshEmail("plover");
    const id = await signUpBusiness(page, request, {
      email: owner,
      businessName: "Plover Plastering",
    });
    await page.getByRole("link", { name: "Account" }).click();
    await expect(cardTitled(page, NUMBER_CARD).getByText("No number yet.")).toBeVisible();
    await expect(page.getByLabel("Number contains")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Find numbers" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Buy/ })).toHaveCount(0);

    // Nor can they go round the page: searching and buying are the admin's alone.
    const search = await apiResponseAs(request, owner, "GET", "/admin/numbers/available");
    expect(search.status()).toBe(403);
    const purchase = await apiResponseAs(request, owner, "POST", `/admin/tenants/${id}/number`, {
      number: "+441134960100",
      confirm: true,
    });
    expect(purchase.status()).toBe(403);
    expect(await numberOf(request, id)).toBeNull();
  });
});

test.describe("a business that's leaving", () => {
  let leaver: string | undefined;

  // The files after this one expect nobody leaving: undo it, even if the test stopped halfway.
  test.afterEach(async ({ request }) => {
    if (!leaver) return;
    const business = await apiAs<TenantView>(request, ADMIN, "GET", `/tenants/${leaver}`);
    if (business.status === "cancelling") {
      await apiAs(request, ADMIN, "POST", `/admin/tenants/${leaver}/undo-cancellation`, {
        confirm: true,
      });
    }
  });

  test("gets no search on its card, and the API won't buy it a number", async ({
    page,
    request,
  }) => {
    // A number bought now would play "service has ended" for good, at a monthly cost, and the
    // release that would end that only comes after 30 days of leaving.
    const owner = freshEmail("teal");
    leaver = await signUpBusiness(page, request, { email: owner, businessName: "Teal Joinery" });
    await apiAs(request, owner, "POST", `/tenants/${leaver}/cancel`, { confirm: true });

    await openAs(page, ADMIN, `/tenants/${leaver}/settings`);
    await expect(cardTitled(page, NUMBER_CARD).getByText("No number yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Find numbers" })).toHaveCount(0);

    const refused = await apiResponseAs(request, ADMIN, "POST", `/admin/tenants/${leaver}/number`, {
      number: "+441134960104",
      confirm: true,
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toEqual({
      error: "This business is cancelling: it doesn't need a number",
    });
    expect(await numberOf(request, leaver)).toBeNull();
  });
});

test.describe("on a server with buying switched off", () => {
  test.use({ extraHTTPHeaders: { [NUMBERS_HEADER]: "switched-off" } });

  test("the admin can look but not buy, the card says why, and the API refuses", async ({
    page,
    request,
  }) => {
    const id = await signUpBusiness(page, request, {
      email: freshEmail("snipe"),
      businessName: "Snipe Glazing",
    });
    await openAs(page, ADMIN, `/tenants/${id}/settings`);
    const card = cardTitled(page, NUMBER_CARD);
    await card.getByRole("button", { name: "Find numbers" }).click();
    await expect(
      card.getByText(
        "Buying is switched off on this server (TWILIO_PURCHASES_ENABLED), so you can look but not buy.",
      ),
    ).toBeVisible();
    const buys = card.getByRole("button", { name: /^Buy/ });
    await expect(buys).not.toHaveCount(0);
    for (const buy of await buys.all()) await expect(buy).toBeDisabled();

    // A request that skips the page, confirmation and all, is refused by the server's switch.
    const refused = await apiResponseAs(request, ADMIN, "POST", `/admin/tenants/${id}/number`, {
      number: "+441134960100",
      confirm: true,
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Buying numbers is switched off on this server (TWILIO_PURCHASES_ENABLED)",
    });
    expect(await numberOf(request, id)).toBeNull();
  });
});
