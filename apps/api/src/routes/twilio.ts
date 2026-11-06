import { Router, urlencoded, type RequestHandler } from "express";
import type pg from "pg";
import { z } from "zod";
import { raiseAlert } from "../alerts.ts";
import { routeInboundCall } from "../core/routing.ts";
import { agentDial, fallbackVoicemail, hangup, rejectCall, serviceEnded } from "../core/twiml.ts";
import { loadInboundCallContext } from "../db/inbound-call.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { VoiceProvider } from "../providers/voice.ts";

export interface TwilioRouteOptions {
  pool: pg.Pool;
  telephony: TelephonyProvider;
  voice: VoiceProvider;
  /** Twilio signs the exact public URL it called; this is that URL's origin. */
  publicBaseUrl: string;
  now?: () => Date;
}

// Twilio sends more fields than these; only what the routing needs is read.
const voiceWebhookSchema = z.object({
  CallSid: z.string().min(1),
  To: z.string().min(1),
  From: z.string().optional(),
});

const dialStatusSchema = z.object({
  CallSid: z.string().min(1),
  DialCallStatus: z.string().optional(),
});

/** Twilio sends "anonymous" or similar when the caller withholds their number. */
const callerNumber = (from: string | undefined): string | null =>
  from !== undefined && /^\+\d+$/.test(from) ? from : null;

/**
 * Twilio's call webhooks: /webhooks/twilio/voice decides what the caller hears, and
 * /webhooks/twilio/dial-status picks up when the agent leg ends. Both are signed.
 */
export function twilioRouter({
  pool,
  telephony,
  voice,
  publicBaseUrl,
  now = () => new Date(),
}: TwilioRouteOptions) {
  const router = Router();
  router.use(urlencoded({ extended: false }));

  const verified: RequestHandler = (req, res, next) => {
    // The URL is rebuilt from the configured public origin, never from the request: behind a
    // proxy, req.host would be the internal address, and Twilio signed the public one.
    const url = `${publicBaseUrl}${req.originalUrl}`;
    const signature = req.headers["x-twilio-signature"];
    const ok = telephony.verifyWebhook({
      url,
      params: req.body as Record<string, string>,
      signature: typeof signature === "string" ? signature : undefined,
    });
    if (!ok) {
      logger.warn("Rejected Twilio webhook", { path: req.path });
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };

  const recordingUrl = `${publicBaseUrl}/webhooks/twilio/recording`;

  router.post("/voice", verified, async (req, res) => {
    const parsed = voiceWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    const { CallSid: callSid, To: to } = parsed.data;
    const from = callerNumber(parsed.data.From);

    const context = await loadInboundCallContext(pool, { to, from });
    const decision = routeInboundCall(context, now());
    const tenantId = context.tenant?.id ?? null;

    let twiml: string;
    switch (decision.kind) {
      case "agent":
        try {
          const { sipUri } = await voice.registerInboundCall({
            providerAgentId: decision.providerAgentId,
            from,
            to,
            variables: decision.variables,
          });
          twiml = agentDial(sipUri, `${publicBaseUrl}/webhooks/twilio/dial-status`);
        } catch (error) {
          // The platform is unreachable: the caller still hears something.
          raiseAlert("voice-platform-unreachable", { tenantId, callSid, error });
          twiml = fallbackVoicemail(recordingUrl);
        }
        break;
      case "voicemail":
        twiml = fallbackVoicemail(recordingUrl);
        break;
      case "ended":
        twiml = serviceEnded(decision.mobile);
        break;
      case "reject":
        twiml = rejectCall();
        break;
    }

    logger.info("Inbound call routed", {
      callSid,
      tenantId,
      route: decision.kind,
      ...("reason" in decision && { reason: decision.reason }),
    });
    res.type("text/xml").send(twiml);
  });

  // After the agent leg ends. A normal end hangs up; anything else means the agent never
  // answered, so the caller gets the voicemail instead of silence.
  router.post("/dial-status", verified, (req, res) => {
    const parsed = dialStatusSchema.safeParse(req.body);
    const status = parsed.success ? parsed.data.DialCallStatus : undefined;
    const answered = status === "completed" || status === "answered";
    if (!answered) {
      logger.warn("Agent leg did not connect", {
        callSid: parsed.success ? parsed.data.CallSid : null,
        status,
      });
    }
    res.type("text/xml").send(answered ? hangup() : fallbackVoicemail(recordingUrl));
  });

  return router;
}
