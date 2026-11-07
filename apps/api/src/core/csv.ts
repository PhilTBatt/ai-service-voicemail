// CSV for the data export (BUILD_PLAN Step 13), as RFC 4180 describes it: a field with a comma,
// a quote or a line break is quoted, with quotes inside doubled, and lines end CRLF. Moments
// are UK clock time, as the dashboard shows them.
//
// Spreadsheets treat a cell starting with =, +, -, @, a tab or a carriage return as a formula.
// Transcripts hold whatever a caller said, so such a cell gets a leading apostrophe and opening
// the file can't run anything (OWASP's advice on CSV injection). Phone numbers in +44 form get
// one too, which also stops a spreadsheet turning them into numbers.

import { ukDateTime } from "./uk-time.ts";

function cell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (value instanceof Date) text = ukDateTime(value);
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    text = value.toString();
  else text = JSON.stringify(value) ?? ""; // objects and arrays (jsonb columns)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
