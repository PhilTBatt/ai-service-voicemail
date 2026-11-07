// The call page behind the links in texts and emails (BUILD_PLAN Step 6). The signed token
// is the only credential: no login yet (Step 10 adds the dashboard proper). The recording
// is streamed through the API, so the provider's URL is never exposed.
import { Readable } from "node:stream";
import { Router } from "express";
import type pg from "pg";
import { verifyCallLink } from "../core/signed-links.ts";
import { findTenantIdByCall } from "../db/cross-tenant.ts";
import { withTenant } from "../db/tenant.ts";
import { parseTranscript } from "../jobs/process-call.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";

export interface CallPageOptions {
  pool: pg.Pool;
  signingSecret: string;
  /** Streams fallback voicemail recordings. Absent until Twilio is configured. */
  telephony?: TelephonyProvider | undefined;
  now?: () => Date;
}

interface CallRow {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  billable_seconds: number;
  caller_number: string | null;
  urgency: string | null;
  summary: string | null;
  flags: string[];
  extracted_fields: Record<string, unknown>;
  transcript: string | null;
  recording_ref: string | null;
  via_fallback: boolean;
}

export function callPageRouter({
  pool,
  signingSecret,
  telephony,
  now = () => new Date(),
}: CallPageOptions) {
  const router = Router();

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
                  `SELECT id, started_at, ended_at, billable_seconds, caller_number, urgency, summary,
                          flags, extracted_fields, transcript, recording_ref, via_fallback
                   FROM calls WHERE id = $1`,
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
    const { call } = loaded;
    const fields = call.extracted_fields;
    const str = (key: string) => (typeof fields[key] === "string" ? fields[key] : null);
    res.json({
      callId: call.id,
      startedAt: call.started_at.toISOString(),
      endedAt: call.ended_at?.toISOString() ?? null,
      durationSeconds: call.billable_seconds,
      callerNumber: call.caller_number,
      urgency: call.urgency,
      summary: call.summary,
      flags: call.flags,
      fields: {
        callerName: str("callerName"),
        callbackNumber: str("callbackNumber"),
        postcode: str("postcode"),
      },
      transcript: call.transcript === null ? null : parseTranscript(call.transcript),
      viaFallback: call.via_fallback,
      recording: {
        // Agent-call recordings (held at the voice platform) are streamed in a later change.
        available: call.recording_ref !== null && call.via_fallback && telephony !== undefined,
        url: `/c/${req.params.token}/recording`,
      },
    });
  });

  router.get("/:token/recording", async (req, res) => {
    const loaded = await loadCall(req.params.token, res);
    if (!loaded) return;
    const { tenantId, call } = loaded;
    if (call.recording_ref === null || !call.via_fallback || !telephony) {
      res.status(404).json({ error: "Recording not available" });
      return;
    }
    const audio = await telephony.fetchRecording(call.recording_ref);
    if (!audio) {
      logger.warn("Recording missing at the provider", { tenantId, callId: call.id });
      res.status(404).json({ error: "Recording not available" });
      return;
    }
    res.type(audio.contentType);
    Readable.fromWeb(audio.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(res);
  });

  return router;
}
