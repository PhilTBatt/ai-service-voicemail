// The page behind the links in texts and emails (BUILD_PLAN Step 6): the call as a person reads
// it, on a phone, with no login. Until this existed, the link answered with the call as raw
// JSON. Built from the same view the dashboard shows (routes/call-view.ts), so both say the
// same thing. No script at all, and everything from the call goes through escapeHtml:
// transcripts and summaries are what callers said, and a caller can say anything.
import { tradespersonFlags, type CallView } from "@callmate/shared";
import { CALL_LINK_TTL_MS } from "./signed-links.ts";
import { URGENCY_LABEL, escapeHtml, formatUkDateTime, nationalNumber } from "./notifications.ts";

/**
 * What the page may load: its own styles, the recording from this site, and nothing else. No
 * script source at all, so even a slip in escaping couldn't run anything.
 */
export const CALL_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const LINK_DAYS = Math.round(CALL_LINK_TTL_MS / (24 * 60 * 60 * 1000));

// The dashboard's colours and type (apps/web/src/design/tokens.css, decision 020), copied as
// values: this page has no script and loads nothing, so it can't share the dashboard's files.
// Change a colour there, change it here.
const STYLE = `
  :root { color-scheme: light dark;
    --bg: #f5f7fb; --surface: #ffffff; --border: #e2e6ee; --text: #131a2a; --muted: #556078;
    --brand: #2952cc; --brand-hover: #2045b3; --link: #2952cc;
    --danger-soft: #fef1ef; --danger-text: #b42318; --danger-border: #f6c7c0;
    --warning-soft: #fff6e6; --warning-text: #93370d; --warning-border: #f9d79e;
    --neutral-soft: #f1f3f7; --neutral-text: #475467; --neutral-border: #e1e5ec;
    --success-text: #05603a; }
  @media (prefers-color-scheme: dark) { :root {
    --bg: #0a0e17; --surface: #121826; --border: #222b3d; --text: #e7eaf2; --muted: #9ba5bb;
    --brand: #3a62e0; --brand-hover: #4c72ec; --link: #8ea7ff;
    --danger-soft: rgb(240 68 56 / 0.13); --danger-text: #ff8b7c; --danger-border: rgb(240 68 56 / 0.38);
    --warning-soft: rgb(247 144 9 / 0.13); --warning-text: #fdb43c; --warning-border: rgb(247 144 9 / 0.38);
    --neutral-soft: rgb(255 255 255 / 0.06); --neutral-text: #b4bdd0; --neutral-border: rgb(255 255 255 / 0.1);
    --success-text: #4fd193; } }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         color: var(--text); background: var(--bg); line-height: 1.5; margin: 0;
         -webkit-font-smoothing: antialiased; }
  main { max-width: 640px; margin: 0 auto; padding: 20px 16px 40px; }
  @media (min-width: 680px) { main { margin: 32px auto; padding: 28px 32px; background: var(--surface);
         border: 1px solid var(--border); border-radius: 14px; } }
  h1 { font-size: 26px; letter-spacing: -0.02em; line-height: 1.25; margin: 10px 0 2px; }
  h2 { font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
       color: var(--muted); margin: 28px 0 8px; }
  a { color: var(--link); }
  .muted { color: var(--muted); margin: 0; font-size: 15px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 9px;
           border-radius: 999px; margin: 0 4px 0 0; background: var(--neutral-soft);
           color: var(--neutral-text); border: 1px solid var(--neutral-border); }
  .badge.emergency { background: var(--danger-soft); color: var(--danger-text); border-color: var(--danger-border); }
  .badge.urgent { background: var(--warning-soft); color: var(--warning-text); border-color: var(--warning-border); }
  .button { display: block; text-align: center; background: var(--brand); color: #fff;
            text-decoration: none; font-weight: 600; font-size: 18px; padding: 14px;
            border-radius: 10px; margin: 20px 0 12px; }
  .button:hover { background: var(--brand-hover); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 20px 0; }
  dt { color: var(--muted); font-size: 15px; }
  dd { margin: 0; }
  .summary { white-space: pre-line; margin: 0; }
  audio { width: 100%; }
  .turn { margin: 0 0 8px; padding: 8px 12px; border-radius: 12px; background: var(--neutral-soft); }
  .footer { color: var(--muted); font-size: 13px; margin-top: 32px; padding-top: 16px;
            border-top: 1px solid var(--border); }
  form { margin: 0 0 16px; }
  button { font: inherit; cursor: pointer; }
  .secondary { display: block; width: 100%; background: var(--surface); color: var(--text); font-weight: 600;
               font-size: 16px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; }
  .done { font-weight: 600; color: var(--success-text); margin: 0 0 4px; }
  .link { background: none; border: none; padding: 0; color: var(--link); text-decoration: underline; }`;

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

/**
 * The call: who, how urgent, the number to ring back, whether it has been, the summary,
 * recording and transcript. With `handledUrl`, a button marks it called back (or open again).
 */
export function callPageHtml(call: CallView, { handledUrl }: { handledUrl?: string } = {}): string {
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
    // The summary's notes about the caller, as plain badges. The pipeline's own flags (a price
    // named, a summary doubted) are for the admin's review queue, not the tradesperson.
    `<p><span class="badge ${urgencyClass}">${escapeHtml(label)}</span>${tradespersonFlags(
      call.flags,
    )
      .map((flag) => `<span class="badge">${escapeHtml(flag)}</span>`)
      .join("")}</p>`,
    `<h1>${escapeHtml(caller)}</h1>`,
    `<p class="muted">${escapeHtml(when)}</p>`,
    number
      ? `<a class="button" href="tel:${escapeHtml(number)}">Call back ${escapeHtml(nationalNumber(number))}</a>`
      : `<p>Their number was withheld.</p>`,
    ...(handledUrl ? [handledForm(call.handledAt, handledUrl)] : []),
    `<dl><dt>Postcode</dt><dd>${escapeHtml(call.fields.postcode ?? "Not given")}</dd>${
      // The caller ID too, when the caller gave another number: a misheard digit in that one
      // still leaves a number that works.
      call.callerNumber && number !== call.callerNumber
        ? `<dt>Rang from</dt><dd><a href="tel:${escapeHtml(call.callerNumber)}">${escapeHtml(nationalNumber(call.callerNumber))}</a></dd>`
        : ""
    }</dl>`,
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

/** Called back, with a way to undo it; or the button that says so. A plain form: no script. */
function handledForm(handledAt: string | null, action: string): string {
  const form = (value: "true" | "false", button: string) =>
    `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="handled" value="${value}">${button}</form>`;
  return handledAt
    ? `<p class="done">✓ Called back ${escapeHtml(formatUkDateTime(new Date(handledAt)))}</p>` +
        form(
          "false",
          '<button class="link" type="submit">Not done yet? Mark it as needing a reply</button>',
        )
    : form("true", '<button class="secondary" type="submit">Mark as called back</button>');
}

/** For a link that has expired, or doesn't match a call: what happened, and where to go. */
export function callPageMessageHtml(
  kind: "expired" | "not-found" | "error",
  dashboardOrigin?: string,
): string {
  const messages: Record<typeof kind, [title: string, text: string]> = {
    expired: [
      "This link has expired",
      `Links in texts and emails work for ${LINK_DAYS} days. The call is still in your AnswerMate dashboard.`,
    ],
    "not-found": [
      "Call not found",
      "This link doesn't match a call. Check it's the whole link from the text or email.",
    ],
    error: [
      "Something went wrong",
      "That didn't work. Go back and try again; if it keeps happening, the call is in your AnswerMate dashboard.",
    ],
  };
  const [title, text] = messages[kind];
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
