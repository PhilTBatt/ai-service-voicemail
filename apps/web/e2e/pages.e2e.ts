// Every screen of the dashboard, checked for what docs/UI.md promises of all of them: one h1,
// a name on every control, nothing wider than a 390px phone, no accessibility problems axe can
// find (WCAG 2.2 A and AA), in light and dark. Nothing here changes any data.
//
// axe: https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  ADMIN,
  callIdOf,
  FERN_LANE,
  freshEmail,
  newSignupCode,
  openAs,
  OTHER_SPARKS,
  OWNER,
  settled,
  tenantIdOf,
} from "./support.ts";

interface Screen {
  name: string;
  /** Who is signed in; null for someone who isn't. */
  who: string | null;
  path: string;
}

/** Every screen, as each kind of person reaches it, with the seeded data. */
async function everyScreen(request: APIRequestContext): Promise<Screen[]> {
  const fern = await tenantIdOf(request, FERN_LANE);
  const sparks = await tenantIdOf(request, OTHER_SPARKS);
  const fernCall = await callIdOf(request, fern, "Boiler leaking under the stairs.");
  const sparksCall = await callIdOf(request, sparks, "Fuse box tripping.");
  const code = await newSignupCode(request);
  return [
    { name: "sign-in", who: null, path: "/" },
    { name: "calls", who: OWNER, path: `/tenants/${fern}` },
    { name: "a call", who: OWNER, path: `/tenants/${fern}/calls/${fernCall}` },
    { name: "assistant", who: OWNER, path: `/tenants/${fern}/profile` },
    { name: "phone setup", who: OWNER, path: `/tenants/${fern}/phone` },
    { name: "account", who: OWNER, path: `/tenants/${fern}/settings` },
    { name: "no such page", who: OWNER, path: "/no-such-page" },
    { name: "businesses", who: ADMIN, path: "/" },
    { name: "admin overview", who: ADMIN, path: "/admin" },
    { name: "admin billing", who: ADMIN, path: "/admin/billing" },
    { name: "admin leaving", who: ADMIN, path: "/admin/leaving" },
    { name: "admin usage", who: ADMIN, path: "/admin/usage" },
    { name: "component gallery", who: ADMIN, path: "/admin/design" },
    { name: "a business setting up", who: ADMIN, path: `/tenants/${sparks}` },
    { name: "a flagged call", who: ADMIN, path: `/tenants/${sparks}/calls/${sparksCall}` },
    { name: "onboarding", who: ADMIN, path: `/tenants/${sparks}/onboarding` },
    { name: "account, with no number", who: ADMIN, path: `/tenants/${sparks}/settings` },
    { name: "phone setup, with no number", who: ADMIN, path: `/tenants/${sparks}/phone` },
    { name: "signup, signed out", who: null, path: `/signup?code=${code}` },
    { name: "signup form", who: freshEmail("looker"), path: `/signup?code=${code}` },
    { name: "a broken signup link", who: null, path: "/signup?code=nonsense" },
  ];
}

/** Opens a screen and waits for everything on it to have loaded. */
async function open(page: Page, screen: Screen): Promise<void> {
  if (screen.who) await openAs(page, screen.who, screen.path);
  else await page.goto(screen.path);
  // Something real first (an empty page has nothing loading either), then nothing loading.
  if (screen.name === "sign-in") {
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  } else {
    await expect(page.locator("h1").first()).toBeVisible();
  }
  if (screen.name === "component gallery") {
    // The gallery shows a loading example and a loading button on purpose, so it's never
    // "not busy": its last section being there means it has all drawn.
    await expect(page.getByRole("heading", { name: "Dialogs and toasts" })).toBeVisible();
  } else {
    await settled(page);
  }
}

/** Runs a check on every screen, each as its own step, so a report names the screen. */
async function eachScreen(
  page: Page,
  request: APIRequestContext,
  check: (screen: Screen) => Promise<void>,
): Promise<void> {
  for (const screen of await everyScreen(request)) {
    await test.step(screen.name, async () => {
      // Each screen starts signed out, as its own visit.
      await page.context().clearCookies();
      await page.goto("/favicon.svg");
      await page.evaluate(() => window.localStorage.clear());
      await open(page, screen);
      await check(screen);
    });
  }
}

test.describe("every screen", () => {
  test.describe.configure({ timeout: 180_000 });

  test("has exactly one h1, the page's name", async ({ page, request }) => {
    await eachScreen(page, request, async (screen) => {
      // The signed-out sign-in box is Clerk's in real life, with its own heading; the test
      // stand-in (src/testing/clerk-stub.tsx) doesn't copy Clerk's markup.
      if (screen.name === "sign-in") return;
      await expect.soft(page.locator("h1"), screen.name).toHaveCount(1);
    });
  });

  test("gives every control a name a screen reader can say", async ({ page, request }) => {
    await eachScreen(page, request, async (screen) => {
      const controls = page
        .locator(
          'input:not([type="hidden"]), select, textarea, button, a[href], [role="radio"], [role="switch"], [role="tab"]',
        )
        .filter({ visible: true });
      for (const control of await controls.all()) {
        const html = await control.evaluate((element) => element.outerHTML.slice(0, 160));
        await expect
          .soft(control, `${screen.name}: ${html}`)
          .toHaveAccessibleName(/\S/, { timeout: 1_000 });
      }
    });
  });

  test("fits a 390px phone without scrolling sideways", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await eachScreen(page, request, async (screen) => {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.scrollingElement!.scrollWidth,
        clientWidth: document.scrollingElement!.clientWidth,
      }));
      expect
        .soft(scrollWidth, `${screen.name} is ${scrollWidth}px wide`)
        .toBeLessThanOrEqual(clientWidth);
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`has nothing axe finds against WCAG 2.2 AA, in ${theme} mode`, async ({
      page,
      request,
    }) => {
      // The device's setting, with no choice stored: what most people get.
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await eachScreen(page, request, async (screen) => {
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
          .analyze();
        const problems = results.violations.map(
          (violation) =>
            `${violation.id}: ${violation.help}\n` +
            violation.nodes
              .slice(0, 5)
              .map((node) => `    ${node.target.join(" ")}: ${node.failureSummary ?? ""}`)
              .join("\n"),
        );
        expect.soft(problems, screen.name).toEqual([]);
      });
    });
  }
});

/** How light a colour is, 0 (black) to 1 (white), from a computed "rgb(r, g, b)". */
function lightness(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).map(Number) as [number, number, number];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function pageColours(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.body);
    const heading = document.querySelector("h1");
    return {
      background: style.backgroundColor,
      text: heading ? getComputedStyle(heading).color : style.color,
    };
  });
}

test.describe("colours", () => {
  test("dark mode, chosen on the device, darkens every kind of page", async ({ page, request }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, "/");
    await page.evaluate(() => window.localStorage.setItem("answermate-theme", "dark"));
    for (const path of [
      `/tenants/${fern}`,
      `/tenants/${fern}/settings`,
      `/tenants/${fern}/profile`,
      "/no-such-page",
    ]) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator("h1").first()).toBeVisible();
      const { background, text } = await pageColours(page);
      expect(lightness(background), `${path} background ${background}`).toBeLessThan(0.25);
      expect(lightness(text), `${path} heading ${text}`).toBeGreaterThan(0.75);
    }
  });

  test("follows a dark device when nothing is chosen, and a light choice beats it", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openAs(page, ADMIN, "/admin/design");
    await expect(page.getByRole("heading", { name: "Buttons" })).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    expect(lightness((await pageColours(page)).background)).toBeLessThan(0.25);

    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(lightness((await pageColours(page)).background)).toBeGreaterThan(0.75);
    // Still light after a reload, before the app has even started (index.html's early script).
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(lightness((await pageColours(page)).background)).toBeGreaterThan(0.75);
  });

  test("the signed-out page follows the device too", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(lightness((await pageColours(page)).background)).toBeLessThan(0.25);
  });
});

test.describe("the keyboard", () => {
  test("the first Tab offers to skip to the page, and Enter goes there", async ({
    page,
    request,
  }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await openAs(page, OWNER, `/tenants/${fern}`);
    await expect(page.getByRole("heading", { level: 1, name: FERN_LANE })).toBeVisible();
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to the page" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible(); // shown once it has focus, for sighted keyboard users
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
  });

  test("on a phone, tapping outside the open menu closes it", async ({ page, request }) => {
    const fern = await tenantIdOf(request, FERN_LANE);
    await page.setViewportSize({ width: 390, height: 844 });
    await openAs(page, OWNER, `/tenants/${fern}`);
    const menu = page.getByRole("button", { name: "Open the menu" });
    await menu.click();
    await expect(page.getByRole("button", { name: "Close the menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // The drawer covers the left; the shaded rest of the page is the scrim.
    await page.mouse.click(380, 600);
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    await expect(page.getByRole("link", { name: "Phone setup" })).toHaveCount(0);
  });
});
