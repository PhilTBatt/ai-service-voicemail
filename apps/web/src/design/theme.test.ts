// The colour theme: what a stored choice means, applying one, and storage that's blocked. The
// tests run without a browser, so the page and its storage are small stand-ins.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readTheme, themeFromStored, THEME_STORAGE_KEY } from "./theme.ts";

/** A stand-in for the browser's window and document, with storage that can be blocked. */
function fakeBrowser({ blocked = false }: { blocked?: boolean } = {}) {
  const stored = new Map<string, string>();
  const refuse = () => {
    throw new Error("SecurityError: storage is blocked");
  };
  const localStorage = {
    getItem: (key: string) => (blocked ? refuse() : (stored.get(key) ?? null)),
    setItem: (key: string, value: string) => (blocked ? refuse() : void stored.set(key, value)),
    removeItem: (key: string) => (blocked ? refuse() : void stored.delete(key)),
  };
  const root = { dataset: {} as Record<string, string | undefined> };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("document", { documentElement: root });
  return { stored, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("themeFromStored", () => {
  it("takes light and dark, and reads anything else as the device's", () => {
    expect(themeFromStored("light")).toBe("light");
    expect(themeFromStored("dark")).toBe("dark");
    for (const junk of [null, "", "system", "Dark", " dark", "blue"]) {
      expect(themeFromStored(junk), String(junk)).toBe("system");
    }
  });
});

describe("applyTheme and readTheme", () => {
  it("marks the page and remembers a light or dark choice", () => {
    const { stored, root } = fakeBrowser();
    applyTheme("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(stored.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(readTheme()).toBe("dark");
  });

  it("forgets the choice and unmarks the page for 'match this device'", () => {
    const { stored, root } = fakeBrowser();
    applyTheme("light");
    applyTheme("system");
    expect("theme" in root.dataset).toBe(false);
    expect(stored.has(THEME_STORAGE_KEY)).toBe(false);
    expect(readTheme()).toBe("system");
  });

  it("still applies a choice for this visit when storage is blocked, without throwing", () => {
    const { root } = fakeBrowser({ blocked: true });
    expect(() => applyTheme("dark")).not.toThrow();
    expect(root.dataset.theme).toBe("dark");
    expect(readTheme()).toBe("system");
  });
});

describe("index.html's early copy of the rule", () => {
  // index.html sets the theme before the page draws, so a dark choice never flashes white.
  // It can't import theme.ts, so it repeats the key and the rule: these must not drift.
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

  it("reads the same storage key", () => {
    expect(html).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
  });

  it("only takes light or dark, as themeFromStored does", () => {
    expect(html).toContain(`theme === "light" || theme === "dark"`);
  });
});
