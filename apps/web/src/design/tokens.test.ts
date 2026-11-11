// Guards for the design tokens (tokens.css), which a typo would break silently: CSS ignores a
// var(--name) that doesn't exist, and a colour missing from dark mode just stays light.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("..", import.meta.url));
const tokens = readFileSync(join(src, "design", "tokens.css"), "utf8");

function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

/** The declarations in the first block opened by `opener` in tokens.css: name to value. */
function block(opener: string): Map<string, string> {
  const start = tokens.indexOf(opener);
  expect(start, opener).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = start;
  for (let i = tokens.indexOf("{", start); i < tokens.length; i += 1) {
    if (tokens[i] === "{") depth += 1;
    if (tokens[i] === "}") depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = tokens.slice(tokens.indexOf("{", start), end);
  const inner = opener.startsWith("@media") ? body.slice(body.indexOf("{", 1)) : body;
  return new Map(
    [...inner.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.replace(/\s+/g, " ")]),
  );
}

describe("design tokens", () => {
  it("defines every custom property the styles and components use", () => {
    const sources = [
      ...filesUnder(src, /\.css$/),
      ...filesUnder(src, /\.tsx?$/).filter((path) => !path.endsWith(".test.ts")),
      join(src, "..", "index.html"),
    ].map((path) => readFileSync(path, "utf8"));
    const defined = new Set(
      sources.flatMap((text) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!)),
    );
    const used = new Set(
      sources.flatMap((text) => [...text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!)),
    );
    const missing = [...used].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it("gives dark mode the same values whether chosen or followed from the device", () => {
    const chosen = block(':root[data-theme="dark"]');
    const followed = block("@media (prefers-color-scheme: dark)");
    expect(chosen.size).toBeGreaterThan(30);
    expect(Object.fromEntries(followed)).toEqual(Object.fromEntries(chosen));
  });

  it("gives every colour and shadow a dark value", () => {
    const light = block(":root {");
    const dark = block(':root[data-theme="dark"]');
    const themed = [...light.keys()].filter((name) => /^--(color|shadow)-/.test(name));
    expect(themed.filter((name) => !dark.has(name))).toEqual([]);
  });
});
