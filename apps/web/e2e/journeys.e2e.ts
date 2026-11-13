// The main jobs people do on the dashboard, end to end, beyond the smoke tests: where messages
// go, filtering calls, marking one called back, cancelling and undoing it, suspending, the
// kill switch, signing up with mistakes, the assistant's every field, the Admin pages, dialogs
// by keyboard, and what nobody may see.
//
// The seeded data is shared with every file after this one (smoke.e2e.ts runs last), so each
// test that changes a seeded business has an afterEach hook that puts it back through the API,
// even if the test failed halfway or ran out of time; tests that make bigger changes sign up a
// business of their own.
import type { TenantView } from "@callmate/shared";
import { expect, test, type Page } from "@playwright/test";
import {
  ADMIN,
  apiAs,
  callIdOf,
  FERN_LANE,
  freshEmail,
  newSignupCode,
  openAs,
  OTHER_SPARKS,
  OWNER,
  settled,
  signUpBusiness,
  tenantIdOf,
  ukDateFromToday,
} from "./support.ts";

const BOILER = "Boiler leaking under the stairs.";
const FUSE_BOX = "Fuse box tripping.";

test.describe("where messages go", () => {
  // Put back as the admin, whose change is saved outright (an owner's new mobile waits for its code).
  test.afterEach(async ({ request }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await apiAs(request, ADMIN, "PUT", `/tenants/${fern}/notifications`, {
      notificationMobile: "+447700900123",
      notificationEmail: null,
    });
  });

  test("a mistake is caught before saving, and a new mobile is confirmed by the code texted to it", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}/settings`);
    const mobile = page.getByLabel("Mobile, for texts about each call");
    const email = page.getByLabel("Email, for the full details and transcript");
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(mobile).toHaveValue("07700 900123");
    await expect(email).toHaveValue("");

    await mobile.fill("0770");
    await email.fill("not an email");
    await save.click();
    await expect(mobile).toHaveAttribute("aria-invalid", "true");
    await expect(mobile).toHaveAccessibleDescription(/must be a UK mobile/);
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toHaveAccessibleDescription(/must be an email address/);
    // Nothing reached the server.
    const unchanged = await apiAs<TenantView>(request, OWNER, "GET", `/tenants/${fern}`);
    expect(unchanged.notificationMobile).toBe("+447700900123");

    // No mobile at all is allowed, but it warns what that costs.
    await mobile.fill("");
    await expect(page.getByText("Without a mobile you won't get texts")).toBeVisible();

    // How UK letterheads write a mobile, and an email with spaces round it. The email is saved;
    // the mobile waits for the code texted to it (PROGRESS open question 4).
    await mobile.fill("+44 (0)7700 900124");
    await email.fill("  office@example.com ");
    await expect(page.getByText("Without a mobile you won't get texts")).toHaveCount(0);
    await save.click();
    await expect(page.getByText("We've texted a code to 07700 900124.")).toBeVisible();
    await expect(mobile).not.toHaveAttribute("aria-invalid", "true");
    const pending = await apiAs<TenantView>(request, OWNER, "GET", `/tenants/${fern}`);
    expect(pending.notificationMobile).toBe("+447700900123");
    expect(pending.pendingMobile).toBe("+447700900124");

    // Still waiting after a reload; a wrong code is refused and counted.
    await page.reload();
    await expect(mobile).toHaveValue("07700 900123");
    await expect(email).toHaveValue("office@example.com");
    await expect(page.getByText("A code was texted to 07700 900124.")).toBeVisible();
    const code = page.getByLabel("Code from the text");
    const confirm = page.getByRole("button", { name: "Confirm mobile" });
    await code.fill("12345");
    await confirm.click();
    await expect(code).toHaveAccessibleDescription(/the code is 6 digits/);
    await code.fill("654321");
    await confirm.click();
    await expect(code).toHaveAccessibleDescription(/That's not the code. 4 tries left./);

    // The right one (the browser tests' server always texts 123456) switches the texts.
    await code.fill("123456");
    await confirm.click();
    await expect(page.getByText("Texts about calls now go to it.")).toBeVisible();
    await expect(mobile).toHaveValue("07700 900124");
    await page.reload();
    await expect(mobile).toHaveValue("07700 900124");
    await expect(page.getByLabel("Code from the text")).toHaveCount(0);
    const confirmed = await apiAs<TenantView>(request, OWNER, "GET", `/tenants/${fern}`);
    expect(confirmed.notificationMobile).toBe("+447700900124");
    expect(confirmed.pendingMobile).toBeNull();
  });
});

test.describe("the calls list", () => {
  test("filters by urgency, needing a reply and dates, and keeps them after opening a call", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}`);
    const call = page.getByRole("link", { name: new RegExp(BOILER) });
    const urgency = page.getByRole("radiogroup", { name: "Urgency" });
    const needsReply = page.getByRole("button", { name: "Needs a reply" });
    const from = page.getByLabel("From", { exact: true });
    const to = page.getByLabel("To", { exact: true });
    await expect(call).toBeVisible();
    await expect(urgency.getByRole("radio", { name: "All" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);

    // The seeded call is urgent, so emergencies alone show nothing.
    await urgency.getByRole("radio", { name: "Emergency" }).click();
    await expect(page.getByText("No calls match")).toBeVisible();
    await expect(call).toHaveCount(0);
    await expect(page).toHaveURL(/\?urgency=emergency$/);

    // The arrow keys move along the options, as in any radio group, and choose as they go.
    await page.keyboard.press("ArrowRight");
    const urgent = urgency.getByRole("radio", { name: "Urgent" });
    await expect(urgent).toHaveAttribute("aria-checked", "true");
    await expect(urgent).toBeFocused();
    await expect(call).toBeVisible();

    await needsReply.click();
    await expect(needsReply).toHaveAttribute("aria-pressed", "true");
    await expect(call).toBeVisible(); // nobody has rung them back yet

    // Dates are UK days, the end day included.
    await from.fill(ukDateFromToday(1));
    await expect(page.getByText("No calls match")).toBeVisible();
    await from.fill("");
    await to.fill(ukDateFromToday(-3));
    await expect(page.getByText("No calls match")).toBeVisible();
    await from.fill(ukDateFromToday(-2));
    await to.fill(ukDateFromToday(0));
    await expect(call).toBeVisible();
    const filtered = page.url();
    expect(new URL(filtered).searchParams.get("from")).toBe(ukDateFromToday(-2));

    // Open the call, and come back by the page's own link: the same list, filters and all.
    await call.click();
    await expect(page.getByRole("heading", { level: 1, name: "Robin Ash" })).toBeVisible();
    await page.getByRole("link", { name: `All calls · ${FERN_LANE}` }).click();
    await expect(page).toHaveURL(filtered);
    await expect(urgent).toHaveAttribute("aria-checked", "true");
    await expect(needsReply).toHaveAttribute("aria-pressed", "true");
    await expect(from).toHaveValue(ukDateFromToday(-2));
    await expect(to).toHaveValue(ukDateFromToday(0));
    await expect(call).toBeVisible();

    // And by the browser's back button.
    await call.click();
    await expect(page.getByRole("heading", { level: 1, name: "Robin Ash" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(filtered);
    await expect(urgent).toHaveAttribute("aria-checked", "true");

    // Clear puts everything back, and the address with it.
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(new RegExp(`/tenants/${fern}$`));
    await expect(urgency.getByRole("radio", { name: "All" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(needsReply).toHaveAttribute("aria-pressed", "false");
    await expect(from).toHaveValue("");
    await expect(to).toHaveValue("");
  });

  test("clears from the empty list too, with one Clear filters button on the page", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}?urgency=spam`);
    await expect(page.getByText("No calls match")).toBeVisible();
    // The empty list's own; the header's steps aside, so no two buttons share a name.
    const clear = page.getByRole("button", { name: "Clear filters" });
    await expect(clear).toHaveCount(1);
    await clear.click();
    await expect(page.getByRole("link", { name: new RegExp(BOILER) })).toBeVisible();
  });

  test("ignores filters in the address that aren't real, rather than hiding calls", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    // A made-up urgency, a date that doesn't exist, and a word where a date goes.
    await openAs(page, OWNER, `/tenants/${fern}?urgency=loud&from=2026-02-30&to=soon`);
    await expect(page.getByRole("link", { name: new RegExp(BOILER) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("");
  });

  test.describe("typed into the date box", () => {
    test.use({ locale: "en-GB" });

    test("a date typed digit by digit, year and all, lands whole, fast or slow", async ({
      page,
      request,
    }) => {
      // Chrome reports the year as each digit goes in (0002, 0020, 0202, 2026). Fed back from
      // the page's address, those once left the box blank at a person's typing speed, and stuck
      // at 0002 at a machine's: typing a date by keyboard didn't work at all.
      const fern = await tenantIdOf(request, FERN_LANE);
      await openAs(page, OWNER, `/tenants/${fern}`);
      const addresses: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) addresses.push(frame.url());
      });
      const from = page.getByLabel("From", { exact: true });
      const to = page.getByLabel("To", { exact: true });

      await from.focus(); // the first part, which is the day in en-GB
      await page.keyboard.type("01112026");
      await expect(from).toHaveValue("2026-11-01");
      await to.focus();
      await page.keyboard.type("15112026", { delay: 150 }); // about a person's speed
      await expect(to).toHaveValue("2026-11-15");
      await expect(page).toHaveURL(/from=2026-11-01&to=2026-11-15/);
      // The list was never asked for a year still being typed.
      expect(addresses.filter((url) => /=0\d{3}-/.test(url))).toEqual([]);

      // Clearing the filters empties boxes that were typed into, too.
      await page.getByRole("button", { name: "Clear filters" }).first().click();
      await expect(from).toHaveValue("");
      await expect(to).toHaveValue("");
    });
  });
});

test.describe("called back", () => {
  test.afterEach(async ({ request }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    const callId = await callIdOf(request, fern, BOILER);
    await apiAs(request, OWNER, "PUT", `/tenants/${fern}/calls/${callId}/handled`, {
      handled: false,
    });
  });

  test("marking a call takes it off the needs-a-reply list, and Not done yet puts it back", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    const callId = await callIdOf(request, fern, BOILER);
    await openAs(page, OWNER, `/tenants/${fern}/calls/${callId}`);
    await page.getByRole("button", { name: "Mark as called back" }).click();
    await expect(page.getByText("Marked as called back")).toBeVisible();
    const badge = page.getByText(/^Called back (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/);
    await expect(badge).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as called back" })).toHaveCount(0);
    await page.reload();
    await expect(badge).toBeVisible(); // the server has it, not just the page

    await page.getByRole("link", { name: `All calls · ${FERN_LANE}` }).click();
    const row = page.getByRole("link", { name: new RegExp(BOILER) });
    await expect(row).toContainText("Called back");
    await page.getByRole("button", { name: "Needs a reply" }).click();
    await expect(page.getByText("No calls match")).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await row.click();
    await page.getByRole("button", { name: "Not done yet" }).click();
    await expect(page.getByText("Back on the list to reply to")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as called back" })).toBeVisible();
    await expect(badge).toHaveCount(0);

    await page.getByRole("link", { name: `All calls · ${FERN_LANE}` }).click();
    await page.getByRole("button", { name: "Needs a reply" }).click();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText("Called back");
  });
});

test.describe("a call's flags", () => {
  // Phil's decision (2026-11-11): the pipeline's own flags are for the admin's review queue. The
  // call page showed "guardrail:price" as a red badge; now it shows the summary's notes, in grey.
  test("the call page shows the summary's note but not the review flag, which the queue keeps", async ({
    page,
    request,
  }) => {
    const sparks = await tenantIdOf(request, OTHER_SPARKS);
    const callId = await callIdOf(request, sparks, FUSE_BOX);
    await openAs(page, ADMIN, `/tenants/${sparks}/calls/${callId}`);
    const note = page.getByText("mentioned burning smell", { exact: true });
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute("data-tone", "neutral");
    await expect(page.getByText("guardrail:price")).toHaveCount(0);

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Calls to review" })).toBeVisible();
    await expect(page.getByText("Named a price", { exact: true })).toBeVisible();
  });
});

test.describe("leaving", () => {
  let leaver: string | undefined;

  // The smoke tests expect nobody leaving: undo it here if the test stopped halfway.
  test.afterEach(async ({ request }) => {
    if (!leaver) return;
    const business = await apiAs<TenantView>(request, ADMIN, "GET", `/tenants/${leaver}`);
    if (business.status === "cancelling") {
      await apiAs(request, ADMIN, "POST", `/admin/tenants/${leaver}/undo-cancellation`, {
        confirm: true,
      });
    }
  });

  test("cancelling needs CANCEL typed, and the admin can undo it", async ({ page, request }) => {
    const id = await signUpBusiness(page, request, {
      email: freshEmail("leaver"),
      businessName: "Heron Tiling",
    });
    leaver = id;
    await page.goto(`/tenants/${id}/settings`);
    const start = page.getByRole("button", { name: "Cancel AnswerMate" });
    await start.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Cancel AnswerMate?" })).toBeVisible();
    const word = dialog.getByLabel("Type CANCEL to confirm");
    const go = dialog.getByRole("button", { name: "Cancel AnswerMate" });
    // Something final: the safe choice isn't pre-selected, the box is, and the button is off.
    await expect(word).toBeFocused();
    await expect(go).toBeDisabled();
    await word.fill("cancel please");
    await expect(go).toBeDisabled();
    await word.press("Enter"); // the form can't be sent around the button either
    await expect(dialog).toBeVisible();

    // Keeping it changes nothing.
    await dialog.getByRole("button", { name: "Keep AnswerMate" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(start).toBeFocused();
    await expect(page.locator(".business-header").getByText("Setting up")).toBeVisible();

    await start.click();
    await word.fill("  cancel ");
    await expect(go).toBeEnabled(); // any case, spaces at the ends aside
    await go.click();
    await expect(page.getByRole("heading", { name: "Cancelled" })).toBeVisible();
    await expect(page.locator(".business-header").getByText("Leaving")).toBeVisible();
    // Its own page offers no undo: only the admin can.
    await expect(page.getByRole("button", { name: "Undo cancellation" })).toHaveCount(0);

    // Phone setup now gives the way back from the diverts.
    await page.getByRole("link", { name: "Phone setup" }).click();
    await expect(page.getByRole("heading", { name: "Turn off your diverts" })).toBeVisible();
    await expect(page.getByText("##61#", { exact: true })).toBeVisible();

    await openAs(page, ADMIN, "/admin/leaving");
    await expect(page.getByText("Heron Tiling")).toBeVisible();
    await page.goto(`/tenants/${id}/settings`);
    await page.getByRole("button", { name: "Undo cancellation" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Undo cancellation" }).click();
    await expect(page.locator(".business-header").getByText("Setting up")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel AnswerMate" })).toBeVisible();
    await page.goto("/admin/leaving");
    await expect(page.getByText("Nobody is leaving")).toBeVisible();
  });
});

test.describe("the admin's switches", () => {
  // All put back after each test, whatever happened: resumed if suspended, both switches off.
  test.afterEach(async ({ request }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    const business = await apiAs<TenantView>(request, ADMIN, "GET", `/tenants/${fern}`);
    if (business.status === "suspended") {
      await apiAs(request, ADMIN, "POST", `/admin/tenants/${fern}/resume`, {});
    }
    await apiAs(request, ADMIN, "PUT", "/admin/kill-switch", { on: false });
    await apiAs(request, ADMIN, "PUT", "/admin/voicemail-transcription", { on: false });
  });

  // Decision 022: off until Phil turns it on, with what it would cost shown first.
  test("voicemail transcription is off, shows the cost, asks before turning on, and turns back off", async ({
    page,
  }) => {
    await openAs(page, ADMIN, "/admin");
    const card = page.getByRole("region", { name: "Voicemail transcription" });
    const dialog = page.getByRole("dialog");
    await expect(card.getByText("Off", { exact: true })).toBeVisible();
    await expect(card.getByTestId("transcription-estimate")).toContainText("Last 30 days:");
    await expect(card).toContainText("$0.024 a minute");

    await card.getByRole("button", { name: "Turn on" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Turn voicemail transcription on?" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(card.getByText("Off", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "Turn on" }).click();
    await dialog.getByRole("button", { name: "Turn on" }).click();
    await expect(card.getByText("On", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "Turn off" }).click();
    await dialog.getByRole("button", { name: "Turn off" }).click();
    await expect(card.getByText("Off", { exact: true })).toBeVisible();
  });

  test("suspending a business asks first, stops its switch, and resuming puts it back", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, ADMIN, `/tenants/${fern}/settings`);
    const header = page.locator(".business-header");
    await page.getByRole("button", { name: "Suspend", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Suspend ${FERN_LANE}?` })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(header.getByText("Answering")).toBeVisible();

    await page.getByRole("button", { name: "Suspend", exact: true }).click();
    await dialog.getByRole("button", { name: "Suspend", exact: true }).click();
    await expect(header.getByText("Suspended")).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

    // The tradesperson sees why, and has no switch to undo it with.
    await openAs(page, OWNER, `/tenants/${fern}`);
    const answering = page.getByRole("region", { name: "Answering" });
    await expect(answering.getByText("Suspended.")).toBeVisible();
    await expect(answering.getByRole("button")).toHaveCount(0);

    await openAs(page, ADMIN, `/tenants/${fern}/settings`);
    await page.getByRole("button", { name: "Resume" }).click();
    await dialog.getByRole("button", { name: "Resume" }).click();
    await expect(header.getByText("Answering")).toBeVisible();
    await expect(page.getByRole("button", { name: "Suspend", exact: true })).toBeVisible();
  });

  test("the kill switch asks first, says so when it's on, and turns back off", async ({ page }) => {
    await openAs(page, ADMIN, "/admin");
    const card = page.getByRole("region", { name: "Kill switch" });
    const dialog = page.getByRole("dialog");
    await expect(card.getByText("Kill switch is off.")).toBeVisible();

    await card.getByRole("button", { name: "Turn on" }).click();
    await expect(dialog.getByRole("heading", { name: "Turn the kill switch on?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(card.getByText("Kill switch is off.")).toBeVisible();

    await card.getByRole("button", { name: "Turn on" }).click();
    await dialog.getByRole("button", { name: "Turn on" }).click();
    await expect(card.getByText("Kill switch is ON.")).toBeVisible();
    await expect(card.getByText("Every call goes to voicemail.")).toBeVisible();

    await card.getByRole("button", { name: "Turn off" }).click();
    await dialog.getByRole("button", { name: "Turn off" }).click();
    await expect(card.getByText("Kill switch is off.")).toBeVisible();
  });
});

test.describe("signing up", () => {
  test("says what's wrong by each field, then accepts a mobile written any usual way", async ({
    page,
    request,
  }) => {
    const code = await newSignupCode(request);
    await openAs(page, freshEmail("checker"), `/signup?code=${code}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Tell us about your business" }),
    ).toBeVisible();
    const send = page.getByRole("button", { name: "Set up my business" });
    const businessName = page.getByLabel("Business name");
    const yourName = page.getByLabel(/^Your name/);
    const mobile = page.getByLabel(/^Mobile, for texts/);
    const network = page.getByLabel(/^Mobile network/);
    const email = page.getByLabel(/^Email for call details/);

    await send.click();
    await expect(page.getByText("Some details need changing. They're marked above.")).toBeVisible();
    await expect(businessName).toHaveAttribute("aria-invalid", "true");
    await expect(businessName).toHaveAccessibleDescription("Can't be empty");
    await expect(yourName).toHaveAccessibleDescription(/Can't be empty/);
    await expect(mobile).toHaveAccessibleDescription(/Must be a UK mobile/);
    await expect(network).toHaveAccessibleDescription(/Choose your network/);
    await expect(page.getByText("Choose yes or no")).toBeVisible();
    await expect(page.getByText("Documents: tick all three to continue")).toBeVisible();
    // Nothing is said about what was fine.
    await expect(email).not.toHaveAttribute("aria-invalid", "true");

    await businessName.fill("Linnet Locks");
    await page.getByLabel("Trade", { exact: true }).selectOption("locksmith");
    await yourName.fill("Alex");
    await mobile.fill("0113 496 0000"); // a landline: texts can't go to it
    await email.fill("not an email");
    await network.selectOption("vodafone");
    await page.getByLabel("Yes", { exact: true }).check();
    await page.getByLabel("I accept the Terms of service").check();
    await page.getByLabel("I accept the Data processing agreement").check();
    await page.getByLabel("I accept the Privacy notice").check();
    await send.click();
    await expect(mobile).toHaveAccessibleDescription(/Must be a UK mobile/);
    await expect(email).toHaveAccessibleDescription(/Must be an email address/);
    await expect(businessName).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Choose yes or no")).toHaveCount(0);
    await expect(page.getByText("Documents: tick all three to continue")).toHaveCount(0);

    // As UK letterheads write it, and an email left empty for the sign-in address.
    await mobile.fill("+44 (0)7700 900555");
    await email.fill("");
    await send.click();
    await expect(page.getByRole("heading", { level: 1, name: "Linnet Locks" })).toBeVisible();
    await page.getByRole("link", { name: "Account" }).click();
    await expect(page.getByLabel("Mobile, for texts about each call")).toHaveValue("07700 900555");

    // The link worked once; it doesn't work again.
    await page.goto(`/signup?code=${code}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "This link can't be used" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Open your dashboard/ })).toBeVisible();
  });

  test("a link that was never made is refused, signed in or not", async ({ page }) => {
    await page.goto("/signup?code=not-a-real-code-at-all");
    await expect(
      page.getByRole("heading", { level: 1, name: "This link can't be used" }),
    ).toBeVisible();
    await expect(page.getByLabel("Business name")).toHaveCount(0);
    await openAs(page, freshEmail("guesser"), "/signup?code=not-a-real-code-at-all");
    await expect(
      page.getByRole("heading", { level: 1, name: "This link can't be used" }),
    ).toBeVisible();
  });
});

test.describe("the assistant's details", () => {
  test("every field saves and comes back after a reload, and bad hours are caught first", async ({
    page,
    request,
  }) => {
    // A business of its own: saving changes the assistant, and the smoke tests check theirs.
    await signUpBusiness(page, request, {
      email: freshEmail("wren"),
      businessName: "Wren Electrical",
    });
    const holidayEnd = ukDateFromToday(30);
    await page.getByRole("link", { name: "Assistant" }).click();
    await expect(page.getByText("Not set up yet.")).toBeVisible();

    await page.getByLabel("Trade", { exact: true }).selectOption("heating_engineer");
    await page.getByLabel("Services, one per line").fill("Boiler servicing\n\n  Radiators  ");
    await page.getByLabel("Areas you cover, one per line").fill("Leeds\nLS6");
    await page.getByRole("switch", { name: "Saturday" }).check();
    await page.getByLabel("Saturday opens").fill("09:00");
    await page.getByLabel("Saturday closes").fill("13:00");
    await page.getByLabel("Monday closes").fill("07:00"); // before it opens
    await page.getByRole("switch", { name: "I'm away" }).check();
    await page.getByLabel("Last day away").fill(holidayEnd);
    await page.getByRole("switch", { name: "I take urgent call-outs" }).check();
    await page.getByRole("button", { name: "Add a question" }).click();
    await page.getByLabel("Question 1").fill("Do you work weekends?");
    await page.getByLabel("Answer").fill("Saturday mornings, yes.");
    await page.getByRole("button", { name: "Add a question" }).click();
    await page.getByLabel("Question 2").fill("A second thought");
    await page.getByRole("button", { name: "Remove question 2" }).click();
    await expect(page.getByLabel("Question 2")).toHaveCount(0);

    const save = page.getByRole("button", { name: "Save", exact: true });
    await save.click();
    await expect(page.getByText("Monday: close must be after open")).toBeVisible();
    await expect(page.getByText("Some details need changing. They're marked above.")).toBeVisible();
    await expect(page.getByText("Not saved yet")).toHaveCount(0); // the problem line replaces it

    await page.getByLabel("Monday closes").fill("17:30");
    await save.click();
    await expect(
      page.getByText("Saved. The assistant will be using these details in about a minute."),
    ).toBeVisible();
    await expect(page.getByText("Version 1")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Trade", { exact: true })).toHaveValue("heating_engineer");
    await expect(page.getByLabel("Services, one per line")).toHaveValue(
      "Boiler servicing\nRadiators",
    );
    await expect(page.getByLabel("Areas you cover, one per line")).toHaveValue("Leeds\nLS6");
    await expect(page.getByRole("switch", { name: "Saturday" })).toBeChecked();
    await expect(page.getByLabel("Saturday opens")).toHaveValue("09:00");
    await expect(page.getByLabel("Saturday closes")).toHaveValue("13:00");
    await expect(page.getByLabel("Monday closes")).toHaveValue("17:30");
    await expect(page.getByRole("switch", { name: "Sunday" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "I'm away" })).toBeChecked();
    await expect(page.getByLabel("Last day away")).toHaveValue(holidayEnd);
    await expect(page.getByRole("switch", { name: "I take urgent call-outs" })).toBeChecked();
    await expect(page.getByLabel("Question 1")).toHaveValue("Do you work weekends?");
    await expect(page.getByLabel("Answer")).toHaveValue("Saturday mornings, yes.");
    await expect(page.getByLabel("Question 2")).toHaveCount(0);
  });
});

test.describe("phone setup", () => {
  test("copies a code to the clipboard, and says so", async ({ page, context, request }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}/phone`);
    await page.getByRole("button", { name: "Copy **61*901#" }).click();
    await expect(page.getByText("Copied", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("**61*901#");
  });

  test("still gives codes to someone not sure of their network", async ({ page, request }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}/phone`);
    await page.getByLabel("Your mobile network").selectOption("");
    // Codes that send calls to this business's number, whatever the network.
    await expect(page.getByText(/^\*\*61\*\+441134960150/).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Copy \*\*61\*\+441134960150/ }),
    ).not.toHaveCount(0);
  });
});

test.describe("the admin, on a business that isn't live yet", () => {
  test("sees which documents it hasn't accepted, and can't accept them for it", async ({
    page,
    request,
  }) => {
    const sparks = await tenantIdOf(request, OTHER_SPARKS);
    await openAs(page, ADMIN, `/tenants/${sparks}/settings`);
    await expect(
      page.getByText(
        "This business hasn't accepted the current Terms of service, Data processing agreement and Privacy notice, so it can't go live until its owner does.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Only the business's owner can accept these.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  });

  test("looking for a number where Twilio isn't set up says so, by the search", async ({
    page,
    request,
  }) => {
    // The smoke-test API has no number buying wired in unless a test asks for it (e2e-server.ts;
    // numbers.e2e.ts does), as a server without Twilio's settings wouldn't: the page must say
    // so rather than show an empty list.
    const sparks = await tenantIdOf(request, OTHER_SPARKS);
    await openAs(page, ADMIN, `/tenants/${sparks}/settings`);
    await page.getByLabel("Number contains").fill("0113 496");
    await page.getByRole("button", { name: "Find numbers" }).click();
    await expect(page.getByText("Twilio isn't set up on this server")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Buy/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Find numbers" })).toBeEnabled();
    await expect(page.getByText("No number yet.")).toBeVisible();
  });
});

test.describe("the Admin pages", () => {
  async function tab(page: Page, label: string) {
    const tabs = page.getByRole("navigation", { name: "Admin pages" });
    await tabs.getByRole("link", { name: label }).click();
    await expect(tabs.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
    // The gallery shows a loading example on purpose, so it's never "not busy".
    if (label !== "Components") await settled(page);
    // No page here fails to load.
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  }

  test("each shows its parts", async ({ page }) => {
    await openAs(page, ADMIN, "/admin");
    await settled(page);
    await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Kill switch" })).toBeVisible();
    for (const stat of [
      "Voicemails left",
      "Texts and emails that failed",
      "Jobs that failed every retry",
    ]) {
      await expect(page.getByText(stat, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Scheduled jobs" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Calls to review" })).toBeVisible();

    await tab(page, "Billing");
    for (const stat of ["Collected this month", "Being collected", "Not collected"]) {
      await expect(page.getByText(stat, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Payments that need you" })).toBeVisible();

    await tab(page, "Leaving");
    await tab(page, "Usage and costs");
    await expect(page.getByRole("heading", { name: "Usage this period" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Estimated costs this month" })).toBeVisible();

    await tab(page, "Components");
    for (const section of [
      "Tones",
      "Buttons",
      "Alerts",
      "Cards",
      "Numbers",
      "Fields",
      "Filters",
      "Empty and loading",
      "Dialogs and toasts",
    ]) {
      await expect(
        page.getByRole("heading", { level: 2, name: section, exact: true }),
      ).toBeVisible();
    }

    await tab(page, "Overview");
    await expect(page).toHaveURL(/\/admin$/);
  });
});

test.describe("dialogs, by keyboard", () => {
  test("a question opens on its action, Escape cancels, and focus returns", async ({ page }) => {
    await openAs(page, ADMIN, "/admin/design");
    const opener = page.getByRole("button", { name: "Open a dialog" });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "A question" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Go ahead" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Shift+Tab reaches Cancel, and Enter on it cancels too.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("a typed confirmation stays off until the words match, in any case", async ({ page }) => {
    await openAs(page, ADMIN, "/admin/design");
    const opener = page.getByRole("button", { name: "Open a typed confirmation" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Something final" });
    const words = dialog.getByLabel("Type the name to go ahead");
    const go = dialog.getByRole("button", { name: "Do it" });
    await expect(words).toBeFocused();
    await expect(go).toBeDisabled();
    for (const near of [
      "Fern Lane",
      "Fern Lane Plumbing!",
      "FernLanePlumbing",
      "Fern  Lane Plumbing",
    ]) {
      await words.fill(near);
      await expect(go, near).toBeDisabled();
    }
    await words.press("Enter");
    await expect(dialog).toBeVisible();
    for (const match of ["Fern Lane Plumbing", "fern lane plumbing", "  FERN LANE PLUMBING  "]) {
      await words.fill(match);
      await expect(go, match).toBeEnabled();
    }
    await words.fill("");
    await expect(go).toBeDisabled();
    await words.fill("fern lane plumbing");
    await words.press("Enter"); // the keyboard can go ahead once it matches
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("the real switch: Escape on the question leaves AnswerMate answering", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}`);
    const card = page.getByRole("region", { name: "Answering" });
    const switchOff = card.getByRole("button", { name: "Switch off" });
    await switchOff.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Switch AnswerMate off?" });
    await expect(dialog).toBeVisible();
    // Stopping calls being answered is dangerous: the keyboard starts on Cancel.
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(switchOff).toBeFocused();
    await expect(card.getByText("AnswerMate is on", { exact: true })).toBeVisible();
  });

  test("a toast says its piece, can be dismissed, and goes by itself", async ({ page }) => {
    await openAs(page, ADMIN, "/admin/design");
    const show = page.getByRole("button", { name: "Show a toast" });
    await show.click();
    const toast = page.getByText("Saved", { exact: true });
    await expect(toast).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(toast).toHaveCount(0);
    await show.click();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 8_000 }); // five seconds, then gone
  });
});

test.describe("what nobody else may see", () => {
  test("a tradesperson can't open another business's calls, even by its address", async ({
    page,
    request,
  }) => {
    const sparks = await tenantIdOf(request, OTHER_SPARKS);
    const sparksCall = await callIdOf(request, sparks, FUSE_BOX);
    await openAs(page, OWNER, `/tenants/${sparks}`);
    await expect(page.getByText("Something went wrong")).toBeVisible();
    await expect(page.getByText(OTHER_SPARKS)).toHaveCount(0);

    await page.goto(`/tenants/${sparks}/calls/${sparksCall}`);
    await expect(page.getByText("Something went wrong")).toBeVisible();
    await expect(page.getByText(FUSE_BOX)).toHaveCount(0);
  });

  test("a tradesperson opening the Admin address gets refusals, not the service's data", async ({
    page,
  }) => {
    await openAs(page, OWNER, "/admin");
    await expect(page.getByText("Something went wrong").first()).toBeVisible();
    await expect(page.getByText(/Kill switch is/)).toHaveCount(0);
    await expect(page.getByText(FUSE_BOX)).toHaveCount(0);
    // And no link to it.
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  });

  test("a call that doesn't exist says so, with a way to try again", async ({ page, request }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}/calls/00000000-0000-4000-8000-000000000000`);
    await expect(page.getByText("Something went wrong")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("an address that isn't a page says so, inside the frame, with the menu still there", async ({
    page,
  }) => {
    await openAs(page, OWNER, "/tenants");
    await expect(
      page.getByRole("heading", { level: 1, name: "There's no page here" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Calls" }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Calls" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: FERN_LANE })).toBeVisible();
  });
});
