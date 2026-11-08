// Smoke tests (BUILD_PLAN Step 10): sign in, see the right businesses, view a call, edit the
// assistant's details. The data comes from apps/api/src/testing/e2e-server.ts.
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("the admin signs in and sees every business", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await expect(page.getByRole("heading", { name: "Businesses" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fern Lane Plumbing" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Other Sparks" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
});

test("the admin marks a flagged call reviewed, and it leaves the queue", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Calls to review" })).toBeVisible();
  // No worker runs during the smoke tests, and the health panel says so.
  await expect(page.getByText("No worker has checked in yet.")).toBeVisible();
  // The pipeline's flag, in words, on the seeded call.
  await expect(page.getByText("Named a price", { exact: true })).toBeVisible();
  await expect(page.getByText("Fuse box tripping.")).toBeVisible();

  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(page.getByText("Nothing to review.")).toBeVisible();
  await expect(page.getByText("Fuse box tripping.")).toHaveCount(0);
  // Still gone after a reload: it was the server that took it out.
  await page.reload();
  await expect(page.getByText("Nothing to review.")).toBeVisible();
});

test("a tradesperson accepts the documents they haven't, and the reminder goes", async ({
  page,
}) => {
  // The seeded business was invited, not signed up, so it has accepted nothing yet.
  await signIn(page, "owner@example.com");
  await expect(page.getByText("Please read and accept the current")).toBeVisible();
  await page.getByRole("link", { name: "Read and accept" }).click();
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await expect(page.getByText("Not accepted yet.")).toHaveCount(3);

  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toBeDisabled(); // not until the box is ticked
  await page.getByLabel(/I've read these documents and accept them/).check();
  await accept.click();

  await expect(page.getByText("Please read and accept the current")).toHaveCount(0);
  await expect(page.getByText(/^Accepted on /)).toHaveCount(3);
});

test("a tradesperson goes straight to their calls and opens one", async ({ page }) => {
  await signIn(page, "owner@example.com");
  await expect(page.getByRole("heading", { name: "Fern Lane Plumbing" })).toBeVisible();
  // Another business's call never shows, and nor does the admin link.
  await expect(page.getByText("Fuse box tripping.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);

  await page.getByRole("link", { name: /Boiler leaking under the stairs/ }).click();
  await expect(page.getByRole("heading", { name: "Robin Ash" })).toBeVisible();
  await expect(page.getByText("My boiler is leaking under the stairs.")).toBeVisible();
  await expect(page.getByRole("link", { name: "07700 900456" })).toHaveAttribute(
    "href",
    "tel:+447700900456",
  );
});

test("a tradesperson edits the assistant's details, and they're still there after a reload", async ({
  page,
}) => {
  await signIn(page, "owner@example.com");
  await page.getByRole("link", { name: "Assistant" }).click();
  const services = page.getByLabel("Services, one per line");
  await services.fill("Boiler repairs\nBurst pipes");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Saved. The assistant will be using these details in about a minute."),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Services, one per line")).toHaveValue(
    "Boiler repairs\nBurst pipes",
  );
});

test("the editor refuses a price in an answer before anything is saved", async ({ page }) => {
  await signIn(page, "owner@example.com");
  await page.getByRole("link", { name: "Assistant" }).click();
  await page.getByRole("button", { name: "Add a question" }).click();
  await page.getByLabel("Question 1").fill("What's the call-out fee?");
  await page.getByLabel("Answer").fill("It's £60 to come out.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Question 1, answer: can't include prices: the assistant never quotes them"),
  ).toBeVisible();
  await expect(page.getByText("Version 2")).toHaveCount(0);
});

test("someone nobody invited is told so, and sees nothing", async ({ page }) => {
  await signIn(page, "stranger@example.com");
  await expect(
    page.getByRole("heading", { name: "This address hasn't been invited" }),
  ).toBeVisible();
  await expect(page.getByText("Fern Lane Plumbing")).toHaveCount(0);
});

test("the admin opens a business's onboarding checklist and sees what's missing", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.getByRole("link", { name: "Other Sparks" }).click();
  await page.getByRole("link", { name: "Onboarding" }).click();
  await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move on to: Terms accepted" })).toBeDisabled();
  await expect(
    page.getByText("Not yet: The terms, DPA and privacy notice haven't all been accepted."),
  ).toBeVisible();
});

test("a new tradesperson signs up through a link and lands on their business", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.getByRole("button", { name: "Create a signup link" }).click();
  const url = await page.locator("code.signup-url").innerText();
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.goto(new URL(url).pathname + new URL(url).search);
  await page.getByLabel("Email").fill("newbie@example.com");
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByLabel("Business name").fill("Kestrel Roofing");
  await page.getByLabel("Trade").selectOption("roofer");
  await page.getByLabel(/^Your name/).fill("Jo");
  await page.getByLabel(/^Mobile, for texts/).fill("07700 900777");
  await page.getByLabel(/^Mobile network/).selectOption("ee");
  await page.getByLabel("No", { exact: true }).check();
  // Not ticking everything is caught before anything is sent.
  await page.getByRole("button", { name: "Set up my business" }).click();
  await expect(page.getByText("Documents: tick all three to continue")).toBeVisible();

  await page.getByLabel("I accept the Terms of service").check();
  await page.getByLabel("I accept the Data processing agreement").check();
  await page.getByLabel("I accept the Privacy notice").check();
  await page.getByRole("button", { name: "Set up my business" }).click();

  await expect(page.getByRole("heading", { name: "Kestrel Roofing" })).toBeVisible();
});

test("a tradesperson sees the divert codes for their network and number", async ({ page }) => {
  await signIn(page, "owner@example.com");
  await page.getByRole("link", { name: "Phone setup" }).click();
  await expect(page.getByText("**61*+441134960150*11*20#")).toBeVisible();
  await expect(page.getByText("**61*901#")).toBeVisible(); // O2's voicemail restore code
  // Another network changes the codes on the spot.
  await page.getByLabel("Your mobile network").selectOption("three");
  await expect(page.getByText("**61*+441134960150#", { exact: true })).toBeVisible();
});
