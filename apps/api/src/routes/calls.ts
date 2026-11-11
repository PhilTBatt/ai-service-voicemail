// The call page behind the links in texts and emails (BUILD_PLAN Step 6). The signed token
// is the only credential: no login (Step 10's dashboard is the logged-in route to the same
// view). A browser gets the page itself (core/call-page.ts); anything asking for JSON gets the
// call as data, as it always has. The recording is streamed through the API, so the provider's
// URL is never exposed.
import { Router, urlencoded, type Request, type Response } from "express";
import type pg from "pg";
import { CALL_PAGE_CSP, callPageHtml, callPageMessageHtml } from "../core/call-page.ts";
import { verifyCallLink } from "../core/signed-links.ts";
import { setCallHandled } from "../db/call-handled.ts";
import { findTenantIdByCall } from "../db/cross-tenant.ts";
import { withTenant } from "../db/tenant.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { VoiceProvider } from "../providers/voice.ts";
import { CALL_VIEW_COLUMNS, presentCall, streamRecording, type CallRow } from "./call-view.ts";

export interface CallPageOptions {
  pool: pg.Pool;
  signingSecret: string;
  /** Streams fallback voicemail recordings. Absent until Twilio is configured. */
  telephony?: TelephonyProvider | undefined;
  /** Streams agent-call recordings. Absent until the voice platform is configured. */
  voice?: VoiceProvider | undefined;
  /** Where an expired link's page sends the person: the dashboard has every call. */
  dashboardOrigin?: string | undefined;
  now?: () => Date;
}

type Loaded =
  | { ok: true; tenantId: string; call: CallRow }
  | { ok: false; status: 404 | 410; kind: "not-found" | "expired" };

/** A browser asks for HTML; fetch() and other clients send no preference, and get JSON. */
function wantsPage(req: Request): boolean {
  return req.accepts(["json", "html"]) === "html";
}

export function callPageRouter({
  pool,
  signingSecret,
  telephony,
  voice,
  dashboardOrigin,
  now = () => new Date(),
}: CallPageOptions) {
  const router = Router();
  const sources = { telephony, voice };

  // The token sits in the URL, so nothing here may be cached or passed on as a referrer. The
  // same address answers a page or JSON depending on what was asked for.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Vary", "Accept");
    next();
  });

  /** Verifies the token and loads the call inside its tenant. */
  async function loadCall(token: string): Promise<Loaded> {
    const check = verifyCallLink(token, signingSecret, now());
    if (!check.ok) {
      // Expired gets its own status so the page can say so; forged and malformed are
      // indistinguishable from a call that doesn't exist.
      return check.reason === "expired"
        ? { ok: false, status: 410, kind: "expired" }
        : { ok: false, status: 404, kind: "not-found" };
    }
    const tenantId = await findTenantIdByCall(pool, check.callId);
    const call =
      tenantId === null
        ? undefined
        : await withTenant(
            pool,
            tenantId,
            async (client) =>
              (
                await client.query<CallRow>(
                  `SELECT ${CALL_VIEW_COLUMNS} FROM calls WHERE id = $1`,
                  [check.callId],
                )
              ).rows[0],
          );
    if (tenantId === null || !call) return { ok: false, status: 404, kind: "not-found" };
    return { ok: true, tenantId, call };
  }

  function refuse(req: Request, res: Response, loaded: Extract<Loaded, { ok: false }>): void {
    if (wantsPage(req)) {
      res.setHeader("Content-Security-Policy", CALL_PAGE_CSP);
      res
        .status(loaded.status)
        .type("html")
        .send(callPageMessageHtml(loaded.kind, dashboardOrigin));
      return;
    }
    res
      .status(loaded.status)
      .json({ error: loaded.kind === "expired" ? "This link has expired" : "Not found" });
  }

  router.get("/:token", async (req, res) => {
    const loaded = await loadCall(req.params.token);
    if (!loaded.ok) {
      refuse(req, res, loaded);
      return;
    }
    const view = presentCall(loaded.call, `/c/${req.params.token}/recording`, sources);
    if (wantsPage(req)) {
      res.setHeader("Content-Security-Policy", CALL_PAGE_CSP);
      res.type("html").send(callPageHtml(view, { handledUrl: `/c/${req.params.token}/handled` }));
      return;
    }
    res.json(view);
  });

  // "Called back", from the page itself: the signed link is the credential here, as it is for
  // reading the call. A plain form post, then back to the page with a 303, so refreshing the
  // page doesn't post again.
  router.post(
    "/:token/handled",
    urlencoded({ extended: false, limit: "1kb" }),
    async (req, res) => {
      const loaded = await loadCall(req.params.token);
      if (!loaded.ok) {
        refuse(req, res, loaded);
        return;
      }
      const handled = (req.body as { handled?: unknown } | undefined)?.handled;
      if (handled !== "true" && handled !== "false") {
        if (wantsPage(req)) {
          res.setHeader("Content-Security-Policy", CALL_PAGE_CSP);
          res.status(400).type("html").send(callPageMessageHtml("error", dashboardOrigin));
          return;
        }
        res.status(400).json({ error: "Expected handled=true or handled=false" });
        return;
      }
      await setCallHandled(pool, {
        tenantId: loaded.tenantId,
        callId: loaded.call.id,
        handled: handled === "true",
        actorUserId: null,
        via: "link",
      });
      res.redirect(303, `/c/${req.params.token}`);
    },
  );

  router.get("/:token/recording", async (req, res) => {
    const loaded = await loadCall(req.params.token);
    if (!loaded.ok) {
      res
        .status(loaded.status)
        .json({ error: loaded.kind === "expired" ? "This link has expired" : "Not found" });
      return;
    }
    await streamRecording(req, res, loaded.tenantId, loaded.call, sources);
  });

  return router;
}
