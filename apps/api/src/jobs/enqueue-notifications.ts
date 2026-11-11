// Queues the texts for a call. Called inside the transaction that makes the call ready to
// notify about (process-call's extraction, or a stored voicemail), through that
// transaction's client, so the jobs commit or roll back with the row (BUILD_PLAN Step 5,
// item 3). The jobs wait in the queue until a worker with SMS configured picks them up.
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import type { CallExtraction } from "../core/extraction.ts";
import { NOTIFY_EMAIL_QUEUE, NOTIFY_EMERGENCY_QUEUE, NOTIFY_SMS_QUEUE } from "./queue.ts";

export interface NotifiableCall {
  tenantId: string;
  callId: string;
  /** From the extraction; null for voicemails and failed extractions. */
  urgency: CallExtraction["urgency"] | null;
  /**
   * Only the emergency texts, now: process-call queues these before asking the LLM anything,
   * so an emergency never waits on it. The summary text and email follow once it's done.
   */
  emergencyOnly?: boolean;
  /**
   * Which emergency script the agent spoke, when that's what makes it one. Carried in the job
   * because notify-emergency otherwise checks the call's stored urgency, which process-call
   * only writes after the LLM: without it, the early job found no emergency and sent nothing.
   */
  emergencyKind?: "gas" | "danger";
}

export type EnqueueNotifications = (client: pg.ClientBase, call: NotifiableCall) => Promise<void>;

export function enqueueNotificationsWith(boss: PgBoss): EnqueueNotifications {
  return async (client, { tenantId, callId, urgency, emergencyOnly = false, emergencyKind }) => {
    const db = { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
    if (urgency === "emergency") {
      await boss.send(
        NOTIFY_EMERGENCY_QUEUE,
        { tenantId, callId, ...(emergencyKind && { kind: emergencyKind }) },
        { singletonKey: callId, db },
      );
    }
    if (emergencyOnly) return;
    await boss.send(NOTIFY_SMS_QUEUE, { tenantId, callId }, { singletonKey: callId, db });
    await boss.send(NOTIFY_EMAIL_QUEUE, { tenantId, callId }, { singletonKey: callId, db });
  };
}
