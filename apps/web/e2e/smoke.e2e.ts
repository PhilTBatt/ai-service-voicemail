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
