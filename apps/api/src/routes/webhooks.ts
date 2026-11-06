import { Router, raw } from "express";
import { logger } from "../logger.ts";
import {
  WebhookVerificationError,
  type CallEndedEvent,
  type VoiceProvider,
} from "../providers/voice.ts";

export interface VoiceWebhookOptions {
  /** Keyed by the name in the URL: /webhooks/voice/retell → providers.retell. */
  providers: Record<string, VoiceProvider>;
  /** Step 5 makes this store the call and enqueue processing, in one transaction. */
  onCallEnded: (event: CallEndedEvent) => Promise<void>;
}

/**
 * POST /webhooks/voice/:provider. The platform signs the exact bytes it sends, so this route
 * keeps the raw body and hands those bytes to the provider for verification. Parsing the
 * JSON first and re-serialising it can change whitespace or key order, and the signature
 * would no longer match.
 */
export function voiceWebhookRouter({ providers, onCallEnded }: VoiceWebhookOptions) {
  const router = Router();

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
      logger.warn("Rejected voice webhook", { provider: providerName, reason: error.message });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (parsed.type === "call_ended") await onCallEnded(parsed);
    res.status(204).end();
  });

  return router;
}
