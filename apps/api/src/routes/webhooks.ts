import { Router, raw } from "express";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { SIGNATURE_FAILURES_PER_WINDOW, Spike } from "../core/spike.ts";
import { logger } from "../logger.ts";
import {
  WebhookVerificationError,
  type CallEndedEvent,
  type FunctionCallEvent,
  type VoiceProvider,
} from "../providers/voice.ts";

export interface VoiceWebhookOptions {
  /** Keyed by the name in the URL: /webhooks/voice/retell → providers.retell. */
  providers: Record<string, VoiceProvider>;
  /** Step 5 makes this store the call and enqueue processing, in one transaction. */
  onCallEnded: (event: CallEndedEvent) => Promise<void>;
  /** Step 6: a mid-call emergency function fired. */
  onFunctionCall?: (event: FunctionCallEvent) => Promise<unknown>;
  alert?: AlertFn;
  now?: () => Date;
}

/**
 * POST /webhooks/voice/:provider. The platform signs the exact bytes it sends, so this route
 * keeps the raw body and hands those bytes to the provider for verification. Parsing the
 * JSON first and re-serialising it can change whitespace or key order, and the signature
 * would no longer match.
 */
export function voiceWebhookRouter({
  providers,
  onCallEnded,
  onFunctionCall = () => Promise.resolve(),
  alert = raiseAlert,
  now = () => new Date(),
}: VoiceWebhookOptions) {
  const router = Router();
  // A run of refused signatures is a forger at work, or a key that changed on one side only.
  const refusals = new Spike({ limit: SIGNATURE_FAILURES_PER_WINDOW });
  const refused = (what: string, providerName: string, reason: string) => {
    logger.warn(what, { provider: providerName, reason });
    if (refusals.record(now())) {
      alert("webhook-signature-spike", { source: providerName, inWindow: refusals.count });
    }
  };

  // Any content type: the signature, not the header, decides whether the request is genuine.
  router.post("/voice/:provider", raw({ type: () => true, limit: "2mb" }), async (req, res) => {
    const providerName = req.params.provider;
    const provider = providers[providerName];
    if (!provider) {
      res.status(404).json({ error: "Unknown provider" });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let parsed;
    try {
      parsed = provider.verifyAndParseWebhook(rawBody, req.headers);
    } catch (error) {
      if (!(error instanceof WebhookVerificationError)) throw error;
      // No detail to the caller: a forger learns nothing from the response.
      refused("Rejected voice webhook", providerName, error.message);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (parsed.type === "call_ended") await onCallEnded(parsed);
    res.status(204).end();
  });

  // POST /webhooks/voice/:provider/function: the platform calling us from inside a call.
  // Same raw-body verification. The JSON answer is what the model sees as the function's
  // result, so it stays short and says nothing the agent could repeat to the caller.
  router.post(
    "/voice/:provider/function",
    raw({ type: () => true, limit: "2mb" }),
    async (req, res) => {
      const providerName = req.params.provider;
      const provider = providers[providerName];
      if (!provider) {
        res.status(404).json({ error: "Unknown provider" });
        return;
      }
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let event: FunctionCallEvent;
      try {
        event = provider.verifyAndParseFunctionCall(rawBody, req.headers);
      } catch (error) {
        if (!(error instanceof WebhookVerificationError)) throw error;
        refused("Rejected voice function call", providerName, error.message);
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      await onFunctionCall(event);
      res.json({ result: "ok" });
    },
  );

  return router;
}
