import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.ts";

describe("toCsv", () => {
  it("writes a header and rows, with CRLF line ends", () => {
    expect(toCsv(["a", "b"], [[1, "two"]])).toBe("a,b\r\n1,two\r\n");
  });

  it("quotes fields with commas, quotes or line breaks, doubling the quotes", () => {
    expect(toCsv(["text"], [["Leeds, LS6"], ['He said "now"'], ["two\nlines"]])).toBe(
      'text\r\n"Leeds, LS6"\r\n"He said ""now"""\r\n"two\nlines"\r\n',
    );
  });

  it("writes empty for missing values, UK time for moments and JSON for objects", () => {
    expect(
      toCsv(["a", "b", "c", "d"], [[null, undefined, new Date("2026-11-08T10:00:00Z"), { x: 1 }]]),
    ).toBe('a,b,c,d\r\n,,2026-11-08 10:00:00,"{""x"":1}"\r\n');
  });

  it("defuses anything a spreadsheet would run as a formula", () => {
    const csv = toCsv(
      ["said"],
      [['=HYPERLINK("http://x")'], ["+447700900123"], ["-1"], ["@SUM(A1)"]],
    );
    expect(csv).toBe(
      'said\r\n"\'=HYPERLINK(""http://x"")"\r\n\'+447700900123\r\n\'-1\r\n\'@SUM(A1)\r\n',
    );
  });
});

describe("toCsv times", () => {
  const at = (iso: string) => toCsv(["at"], [[new Date(iso)]]).split("\r\n")[1];

  it("writes moments as UK clock time, across the clocks going forward and back", () => {
    expect(at("2026-03-29T00:59:59Z")).toBe("2026-03-29 00:59:59"); // GMT, a second before
    expect(at("2026-03-29T01:00:00Z")).toBe("2026-03-29 02:00:00"); // BST from 01:00 GMT
    expect(at("2026-07-01T10:00:00Z")).toBe("2026-07-01 11:00:00");
    expect(at("2026-10-25T00:59:59Z")).toBe("2026-10-25 01:59:59"); // BST's last second
    expect(at("2026-10-25T01:00:00Z")).toBe("2026-10-25 01:00:00"); // GMT again
  });
});
