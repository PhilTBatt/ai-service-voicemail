// The process-call job: extraction, triage, usage and notifications (BUILD_PLAN Step 5).
// This commit only queues it; the next ones fill it in.
import { logger } from "../logger.ts";

export interface ProcessCallJobData {
  tenantId: string;
  callId: string;
  providerCallId: string;
}

/** Placeholder until the LLM extraction lands: acknowledges the call so the queue doesn't pile up. */
export function runProcessCall(data: ProcessCallJobData): Promise<void> {
  logger.info("process-call received (extraction not built yet)", {
    tenantId: data.tenantId,
    callId: data.callId,
  });
  return Promise.resolve();
}
