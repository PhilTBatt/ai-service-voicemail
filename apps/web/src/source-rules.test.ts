// Rules for the dashboard's source that a type check can't see (docs/UI.md, section 5).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const sources = filesUnder(SRC).filter((path) => /\.(tsx?|css)$/.test(path));
const read = (path: string) => readFileSync(path, "utf8");
const name = (path: string) => relative(SRC, path).replaceAll("\\", "/");

describe("the dashboard's source", () => {
  it("has no text garbled by a wrong encoding", () => {
    // UTF-8 read as Windows-1252 turns an ellipsis into three letters (a-circumflex, euro sign,
    // broken bar) and an e-acute into two: the ellipsis one once reached the loading message
    // screen readers announce. Built from code points so this file doesn't trip its own check.
    const ch = (...codes: number[]) => String.fromCodePoint(...codes);
    const garbled = new RegExp(
      [
        ch(0xe2, 0x20ac), // the start of a garbled ellipsis or dash
        `${ch(0xc3)}[${ch(0x80)}-${ch(0xbf)}]`, // a garbled accented letter
        `${ch(0xc2)}[${ch(0xa0)}-${ch(0xbf)}]`, // a garbled pound sign or non-breaking space
        ch(0xfffd), // the replacement character: bytes that weren't text at all
      ].join("|"),
    );
    const found = sources.filter((path) => garbled.test(read(path))).map(name);
    expect(found).toEqual([]);
  });

  it("gives pages no styles of their own: they're made of components and patterns", () => {
    const pages = sources.filter((path) => name(path).startsWith("pages/"));
    expect(pages.length).toBeGreaterThan(5);
    const styled = pages.filter((path) => /style=\{\{/.test(read(path))).map(name);
    expect(styled).toEqual([]);
  });

  it("keeps the faint text colour off words: it fails WCAG contrast for text", () => {
    // tokens.css: --color-text-subtle is for borders, icons and placeholders. As text colour it
    // gave the sidebar's "Times are UK time." 3.1:1 against white (4.5:1 needed), which axe
    // caught (e2e/pages.e2e.ts). Placeholders are the one place it may colour text.
    const css = sources.filter((path) => path.endsWith(".css"));
    const misuses: string[] = [];
    for (const path of css) {
      for (const rule of read(path).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, selector = "", body = ""] = rule;
        if (/(^|[;\s])color:\s*var\(--color-text-subtle\)/.test(body)) {
          if (!selector.includes("::placeholder"))
            misuses.push(`${name(path)}: ${selector.trim()}`);
        }
      }
    }
    expect(misuses).toEqual([]);
  });

  it("uses the design system's dialogs, never the browser's own boxes", () => {
    // `confirm(...)` on its own is the design system's hook (useConfirm), so only the
    // browser's are looked for: window.confirm and friends, or a bare alert() or prompt().
    const boxes = /\bwindow\.(alert|confirm|prompt)\(|(^|[^.\w])(alert|prompt)\(/m;
    const found = sources
      .filter((path) => path.endsWith(".tsx"))
      .filter((path) => boxes.test(read(path).replace(/\/\/.*$/gm, "")))
      .map(name);
    expect(found).toEqual([]);
  });
});
