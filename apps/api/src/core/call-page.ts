// The page behind the links in texts and emails (BUILD_PLAN Step 6): the call as a person reads
// it, on a phone, with no login. Until this existed, the link answered with the call as raw
// JSON. Built from the same view the dashboard shows (routes/call-view.ts), so both say the
// same thing. No script at all, and everything from the call goes through escapeHtml:
// transcripts and summaries are what callers said, and a caller can say anything.
import type { CallView } from "@callmate/shared";
import { CALL_LINK_TTL_MS } from "./signed-links.ts";
import { URGENCY_LABEL, escapeHtml, formatUkDateTime, nationalNumber } from "./notifications.ts";

/**
 * What the page may load: its own styles, the recording from this site, and nothing else. No
 * script source at all, so even a slip in escaping couldn't run anything.
 */
export const CALL_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const LINK_DAYS = Math.round(CALL_LINK_TTL_MS / (24 * 60 * 60 * 1000));

const STYLE = `
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111;
         background: #fff; line-height: 1.5; margin: 0; }
  main { max-width: 640px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 24px; margin: 8px 0 0; }
  h2 { font-size: 17px; margin: 24px 0 8px; }
  .muted { color: #555; margin: 0; }
  .badge { display: inline-block; font-size: 13px; font-weight: 700; padding: 2px 8px;
           border-radius: 4px; background: #eee; margin: 0 4px 0 0; }
  .badge.emergency { background: #b00020; color: #fff; }
  .badge.urgent { background: #e65100; color: #fff; }
  .button { display: block; text-align: center; background: #0b57d0; color: #fff;
            text-decoration: none; font-weight: 700; font-size: 18px; padding: 14px;
            border-radius: 8px; margin: 16px 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 16px 0; }
  dt { color: #555; font-weight: 600; }
  dd { margin: 0; }
  .summary { white-space: pre-line; margin: 0; }
  audio { width: 100%; }
  .turn { margin: 0 0 8px; }
  .footer { color: #666; font-size: 13px; margin-top: 32px; }
  @media (prefers-color-scheme: dark) {
    body { background: #121212; color: #eee; }
    .muted, dt { color: #aaa; }
    .badge { background: #333; }
    .footer { color: #999; }
  }`;

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en-GB"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // The link carries a caller's details: never in a search engine, whoever pastes it where.
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style></head>`,
    `<body><main>${body}</main></body></html>`,
  ].join("\n");
}

/** "2 min 5 sec", "42 sec". */
export function spokenDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) return `${rest} sec`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
}

/** The call: who, how urgent, the number to ring back, the summary, recording and transcript. */
export function callPageHtml(call: CallView): string {
  const label =
    call.urgency !== null && Object.hasOwn(URGENCY_LABEL, call.urgency)
      ? URGENCY_LABEL[call.urgency as keyof typeof URGENCY_LABEL]
      : URGENCY_LABEL.other;
  const caller = call.fields.callerName ?? "Unknown caller";
  const number = call.fields.callbackNumber ?? call.callerNumber;
  const urgencyClass =
    call.urgency === "emergency" || call.urgency === "urgent" ? call.urgency : "";
  const when = [
    formatUkDateTime(new Date(call.startedAt)),
    spokenDuration(call.durationSeconds),
    ...(call.viaFallback ? ["voicemail"] : []),
  ].join(" · ");

  const body = [
    `<p><span class="badge ${urgencyClass}">${escapeHtml(label)}</span>${call.flags
      .map((flag) => `<span class="badge">${escapeHtml(flag)}</span>`)
      .join("")}</p>`,
    `<h1>${escapeHtml(caller)}</h1>`,
    `<p class="muted">${escapeHtml(when)}</p>`,
    number
      ? `<a class="button" href="tel:${escapeHtml(number)}">Call back ${escapeHtml(nationalNumber(number))}</a>`
      : `<p>Their number was withheld.</p>`,
    `<dl><dt>Postcode</dt><dd>${escapeHtml(call.fields.postcode ?? "Not given")}</dd></dl>`,
    "<h2>Summary</h2>",
    `<p class="summary">${escapeHtml(
      call.summary ?? (call.viaFallback ? "A voicemail: listen to it below." : "No summary yet."),
    )}</p>`,
    ...(call.recording.available
      ? [
          "<h2>Recording</h2>",
          `<audio controls preload="none" src="${escapeHtml(call.recording.url)}"></audio>`,
        ]
      : []),
    "<h2>Transcript</h2>",
    call.transcript === null || call.transcript.length === 0
      ? '<p class="muted">No transcript for this call.</p>'
      : call.transcript
          .map(
            (turn) =>
              `<p class="turn"><strong>${turn.role === "agent" ? "Assistant" : "Caller"}:</strong> ${escapeHtml(turn.text)}</p>`,
          )
          .join("\n"),
    `<p class="footer">This page shows a caller's personal details: please don't pass the link on. It works for ${LINK_DAYS} days after it was sent; after that, the call is in your AnswerMate dashboard.</p>`,
  ].join("\n");
  return page(`${label}: ${caller}`, body);
}

/** For a link that has expired, or doesn't match a call: what happened, and where to go. */
export function callPageMessageHtml(
  kind: "expired" | "not-found",
  dashboardOrigin?: string,
): string {
  const [title, text] =
    kind === "expired"
      ? [
          "This link has expired",
          `Links in texts and emails work for ${LINK_DAYS} days. The call is still in your AnswerMate dashboard.`,
        ]
      : [
          "Call not found",
          "This link doesn't match a call. Check it's the whole link from the text or email.",
        ];
  return page(
    title,
    [
      `<h1>${escapeHtml(title)}</h1>`,
      `<p>${escapeHtml(text)}</p>`,
      ...(dashboardOrigin
        ? [`<a class="button" href="${escapeHtml(dashboardOrigin)}">Open your dashboard</a>`]
        : []),
    ].join("\n"),
  );
}
