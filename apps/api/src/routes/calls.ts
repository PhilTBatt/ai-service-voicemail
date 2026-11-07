// The call page behind the links in texts and emails (BUILD_PLAN Step 6). The signed token
// is the only credential: no login (Step 10's dashboard is the logged-in route to the same
// view). The recording is streamed through the API, so the provider's URL is never exposed.
import { Router } from "express";
import type pg from "pg";
import { verifyCallLink } from "../core/signed-links.ts";
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
  now?: () => Date;
}

export function callPageRouter({
  pool,
  signingSecret,
  telephony,
  voice,
  now = () => new Date(),
}: CallPageOptions) {
  const router = Router();
  const sources = { telephony, voice };

  // The token sits in the URL, so nothing here may be cached or passed on as a referrer.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  /** Verifies the token and loads the call inside its tenant, or answers for the caller and returns null. */
  async function loadCall(
    token: string,
    res: import("express").Response,
  ): Promise<{ tenantId: string; call: CallRow } | null> {
    const check = verifyCallLink(token, signingSecret, now());
    if (!check.ok) {
      // Expired gets its own status so the page can say so; forged and malformed are
      // indistinguishable from a call that doesn't exist.
      if (check.reason === "expired") res.status(410).json({ error: "This link has expired" });
      else res.status(404).json({ error: "Not found" });
      return null;
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
    if (tenantId === null || !call) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    return { tenantId, call };
  }

  router.get("/:token", async (req, res) => {
    const loaded = await loadCall(req.params.token, res);
    if (!loaded) return;
    res.json(presentCall(loaded.call, `/c/${req.params.token}/recording`, sources));
  });

  router.get("/:token/recording", async (req, res) => {
    const loaded = await loadCall(req.params.token, res);
    if (!loaded) return;
    await streamRecording(res, loaded.tenantId, loaded.call, sources);
  });

  return router;
}
