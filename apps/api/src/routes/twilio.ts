import { Router, urlencoded, type Request, type RequestHandler, type Response } from "express";
import type { EnqueueOnboarding } from "../jobs/onboarding.ts";
import type pg from "pg";
import { z } from "zod";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import { e164OrNull } from "../core/phone.ts";
import { parseSmsCommand, ukToday } from "../core/sms-commands.ts";
import { routeInboundCall } from "../core/routing.ts";
import {
  agentDial,
  demoLimitReached,
  fallbackVoicemail,
  hangup,
  noSmsReply,
  rejectCall,
  serviceEnded,
  smsReply,
  voicemailDone,
} from "../core/twiml.ts";
import { findTenantIdByMobile, findTenantIdByProviderRef } from "../db/cross-tenant.ts";
import { loadInboundCallContext } from "../db/inbound-call.ts";
import { withTenant } from "../db/tenant.ts";
import { applySmsCommand } from "../db/tenant-commands.ts";
import type { EnqueueNotifications } from "../jobs/enqueue-notifications.ts";
import { storeFallbackVoicemail } from "../db/voicemails.ts";
import {
  FALLBACK_VOICEMAILS_PER_WINDOW,
  SIGNATURE_FAILURES_PER_WINDOW,
  Spike,
} from "../core/spike.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { VoiceProvider } from "../providers/voice.ts";

export interface TwilioRouteOptions {
  pool: pg.Pool;
  telephony: TelephonyProvider;
  voice: VoiceProvider;
  /** Twilio signs the exact public URL it called; this is that URL's origin. */
  publicBaseUrl: string;
  /** Replies to SMS commands go through the outbound allowlist like every other message. */
  outbound: OutboundPolicy;
  /** Re-syncs a profile whose holiday dates changed, so the agent's prompt names the new date. */
  enqueueSync: (job: { tenantId: string; profileVersion: number }) => Promise<unknown>;
  /** Queues the "new voicemail" text when a fallback voicemail is stored. */
  enqueueNotifications: EnqueueNotifications;
  /** Takes a business live after its test call, which arrives as a voicemail (Step 11). */
  enqueueOnboarding?: EnqueueOnboarding;
  alert?: AlertFn;
  now?: () => Date;
  /** How long the voice platform gets to take a call before the caller gets the voicemail. */
  registerTimeoutMs?: number;
  /** How long routing has, all told, to answer Twilio: Twilio itself gives up at 15 s. */
  deadlineMs?: number;
}

/** Rejects if `work` hasn't settled within `ms`: for steps that mustn't keep a caller waiting. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} took longer than ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

// Twilio sends more fields than these; only what each route needs is read.
const voiceWebhookSchema = z.object({
  CallSid: z.string().min(1),
  To: z.string().min(1),
  From: z.string().optional(),
});

const dialStatusSchema = z.object({
  CallSid: z.string().min(1),
  DialCallStatus: z.string().optional(),
  /** "The duration in seconds of the dialed call" (Twilio's <Dial> docs). Unreadable: unknown. */
  DialCallDuration: z.coerce.number().int().nonnegative().optional().catch(undefined),
  /** The caller's own leg. Logged only: the <Dial> docs don't say what it holds here. */
  CallStatus: z.string().optional(),
});

/**
 * An answered agent leg shorter than this can't have been a call the agent finished: its
 * opening disclosure alone takes about ten seconds, and the caller can't talk over it.
 */
export const AGENT_DROPPED_UNDER_SECONDS = 8;

const inboundSmsSchema = z.object({
  MessageSid: z.string().min(1),
  From: z.string().min(1),
  Body: z.string().default(""),
});

const smsStatusSchema = z.object({
  MessageSid: z.string().min(1),
  MessageStatus: z.string().min(1),
  ErrorCode: z.string().optional(),
});

/** Twilio's code for a recipient who replied STOP: texts to them fail until they reply START. */
const OPTED_OUT_ERROR_CODE = "21610";

const recordingCallbackSchema = z.object({
  CallSid: z.string().min(1),
  RecordingSid: z.string().min(1),
  RecordingUrl: z.url(),
  RecordingStatus: z.string(),
  RecordingDuration: z.coerce.number().optional(),
});

/**
 * Twilio's call webhooks, all signed: /voice decides what the caller hears, /dial-status
 * picks up when the agent leg ends, /voicemail-done closes a voicemail, and /recording
 * stores one once Twilio has it.
 */
export function twilioRouter({
  pool,
  telephony,
  voice,
  publicBaseUrl,
  outbound,
  enqueueSync,
  enqueueNotifications,
  enqueueOnboarding,
  alert = raiseAlert,
  now = () => new Date(),
  registerTimeoutMs = 6_000,
  deadlineMs = 10_000,
}: TwilioRouteOptions) {
  const router = Router();
  router.use(urlencoded({ extended: false }));

  // Two of Step 8's alerts: more fallback voicemails than a healthy service gives (the voice
  // platform down, or a bad sync), and a run of refused signatures (a forger, or a changed
  // auth token on one side only).
  const fallbacks = new Spike({ limit: FALLBACK_VOICEMAILS_PER_WINDOW });
  const refusals = new Spike({ limit: SIGNATURE_FAILURES_PER_WINDOW });

  const verified: RequestHandler = (req, res, next) => {
    // The URL is rebuilt from the configured public origin, never from the request: behind a
    // proxy, req.host would be the internal address, and Twilio signed the public one.
    const url = `${publicBaseUrl}${req.originalUrl}`;
    const signature = req.headers["x-twilio-signature"];
    const ok = telephony.verifyWebhook({
      url,
      // Express leaves req.body undefined for anything but a form body; a probe with JSON
      // must get a 403, not a crash.
      params: (req.body ?? {}) as Record<string, string>,
      signature: typeof signature === "string" ? signature : undefined,
    });
    if (!ok) {
      logger.warn("Rejected Twilio webhook", { path: req.path });
      if (refusals.record(now())) {
        alert("webhook-signature-spike", { source: "twilio", inWindow: refusals.count });
      }
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };

  /** The fallback voicemail, whatever the reason: every play counts towards the spike alert. */
  const voicemail = () => {
    if (fallbacks.record(now())) {
      alert("fallback-voicemail-spike", { inWindow: fallbacks.count });
    }
    return fallbackVoicemail({
      actionUrl: `${publicBaseUrl}/webhooks/twilio/voicemail-done`,
      recordingStatusCallbackUrl: `${publicBaseUrl}/webhooks/twilio/recording`,
    });
  };

  router.post("/voice", verified, async (req, res) => {
    // Whatever happens below, the caller hears something before Twilio gives up on us (15 s):
    // at the deadline they get the voicemail, and anything later is dropped.
    const deadline = setTimeout(() => {
      if (res.headersSent) return;
      logger.warn("Inbound call routing ran out of time: voicemail", { path: req.path });
      res.type("text/xml").send(voicemail());
    }, deadlineMs);
    try {
      await routeCall(req, res);
    } finally {
      clearTimeout(deadline);
    }
  });

  const routeCall = async (req: Request, res: Response) => {
    const parsed = voiceWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    const { CallSid: callSid, To: to } = parsed.data;
    const from = e164OrNull(parsed.data.From);

    const context = await loadInboundCallContext(pool, { to, from }, now());
    const decision = routeInboundCall(context, now());
    const tenantId = context.tenant?.id ?? null;

    let twiml: string;
    switch (decision.kind) {
      case "agent":
        try {
          const { sipUri } = await within(
            voice.registerInboundCall({
              providerAgentId: decision.providerAgentId,
              from,
              to,
              variables: decision.variables,
            }),
            registerTimeoutMs,
            "Registering the call with the voice platform",
          );
          twiml = agentDial(sipUri, `${publicBaseUrl}/webhooks/twilio/dial-status`);
        } catch (error) {
          // The platform is unreachable, or too slow: the caller still hears something.
          alert("voice-platform-unreachable", { tenantId, callSid, error });
          twiml = voicemail();
        }
        break;
      case "voicemail":
        twiml = voicemail();
        break;
      case "ended":
        twiml = serviceEnded(decision.mobile);
        break;
      case "reject":
        twiml = rejectCall();
        break;
      case "demo-limit":
        twiml = demoLimitReached();
        break;
    }

    logger.info("Inbound call routed", {
      callSid,
      tenantId,
      route: decision.kind,
      ...("reason" in decision && { reason: decision.reason }),
    });
    if (!res.headersSent) res.type("text/xml").send(twiml);
  };

  // After the agent leg ends, Twilio carries on with the caller using what this returns
  // ("Twilio will continue the initial call after the dialed party hangs up", its <Dial> docs).
  // A normal end hangs up. An agent that never answered, or answered and dropped before it
  // could have finished its opening, leaves the caller with the voicemail instead of a dead
  // line. If the caller had hung up first, nobody hears this (the docs don't say whether
  // Twilio even asks), so the voicemail is safe either way.
  router.post("/dial-status", verified, (req, res) => {
    const parsed = dialStatusSchema.safeParse(req.body);
    const status = parsed.success ? parsed.data.DialCallStatus : undefined;
    const seconds = parsed.success ? parsed.data.DialCallDuration : undefined;
    const answered = status === "completed" || status === "answered";
    const droppedEarly = answered && seconds !== undefined && seconds < AGENT_DROPPED_UNDER_SECONDS;
    if (!answered || droppedEarly) {
      logger.warn(droppedEarly ? "Agent leg ended early" : "Agent leg did not connect", {
        callSid: parsed.success ? parsed.data.CallSid : null,
        status,
        seconds,
        // What the caller's leg says at this point, to learn from the first live drops.
        callStatus: parsed.success ? parsed.data.CallStatus : undefined,
      });
    }
    res.type("text/xml").send(answered && !droppedEarly ? hangup() : voicemail());
  });

  router.post("/voicemail-done", verified, (_req, res) => {
    res.type("text/xml").send(voicemailDone());
  });

  // Twilio tells us a recording is ready. The call's numbers aren't in this callback, so
  // they're fetched from Twilio; the tenant comes from the number that was dialled.
  router.post("/recording", verified, async (req, res) => {
    const parsed = recordingCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    const { CallSid: callSid, RecordingUrl: recordingUrl, RecordingStatus: status } = parsed.data;
    if (status !== "completed") {
      logger.warn("Fallback voicemail recording did not complete", { callSid, status });
      res.status(204).end();
      return;
    }
    const call = await telephony.getCall(callSid);
    if (!call) {
      logger.warn("Recording callback for a call Twilio doesn't know", { callSid });
      res.status(204).end();
      return;
    }
    const result = await storeFallbackVoicemail(
      pool,
      {
        callSid,
        from: call.from,
        to: call.to,
        recordingUrl,
        durationSeconds: parsed.data.RecordingDuration ?? call.durationSeconds,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
      },
      enqueueNotifications,
      enqueueOnboarding,
    );
    logger.info("Fallback voicemail callback handled", { callSid, ...result });
    res.status(204).end();
  });

  // A text to the notification number. Only a tenant's registered mobile gets a reply;
  // anything else is dropped silently, so the number can't be used to probe for tenants.
  router.post("/sms", verified, async (req, res) => {
    const parsed = inboundSmsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    const { MessageSid: messageSid, Body: body } = parsed.data;
    const from = e164OrNull(parsed.data.From);
    const tenantId = from === null ? null : await findTenantIdByMobile(pool, from);
    res.type("text/xml");
    if (tenantId === null || from === null) {
      logger.info("Ignored SMS from an unknown sender", { messageSid });
      res.send(noSmsReply());
      return;
    }

    const command = parseSmsCommand(body, ukToday(now()));
    const result = await applySmsCommand(pool, tenantId, command, now());
    if (result.resyncProfileVersion !== undefined) {
      await enqueueSync({ tenantId, profileVersion: result.resyncProfileVersion });
    }
    logger.info("SMS command handled", { messageSid, tenantId, command: command.kind });

    const decision = checkOutbound(outbound, from);
    if (!decision.allowed) {
      logger.warn("SMS reply blocked by the outbound allowlist", {
        tenantId,
        reason: decision.reason,
      });
      res.send(noSmsReply());
      return;
    }
    res.send(smsReply(result.reply));
  });

  // Delivery receipts for the texts we send: did the handset get it? Only the final verdicts
  // change anything; 'queued' and 'sent' are Twilio's own progress, not ours.
  router.post("/sms-status", verified, async (req, res) => {
    const parsed = smsStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    const { MessageSid: messageSid, MessageStatus: status, ErrorCode: errorCode } = parsed.data;
    const final =
      status === "delivered"
        ? "delivered"
        : status === "undelivered" || status === "failed"
          ? "undelivered"
          : null;
    if (final === null) {
      res.status(204).end();
      return;
    }
    const tenantId = await findTenantIdByProviderRef(pool, messageSid);
    if (tenantId === null) {
      logger.info("Delivery receipt for a text we don't know", { messageSid, status });
      res.status(204).end();
      return;
    }
    const row = await withTenant(
      pool,
      tenantId,
      async (client) =>
        (
          await client.query<{ call_id: string }>(
            `UPDATE notifications SET status = $2, failure_code = $3
             WHERE provider_ref = $1 AND status IN ('sent', 'delivered', 'undelivered')
             RETURNING call_id`,
            [messageSid, final, final === "undelivered" ? (errorCode ?? null) : null],
          )
        ).rows[0],
    );
    if (row && final === "undelivered") {
      alert(errorCode === OPTED_OUT_ERROR_CODE ? "recipient-opted-out" : "sms-undelivered", {
        tenantId,
        callId: row.call_id,
        errorCode: errorCode ?? null,
      });
    }
    logger.info("Delivery receipt handled", { messageSid, tenantId, status: final });
    res.status(204).end();
  });

  return router;
}
