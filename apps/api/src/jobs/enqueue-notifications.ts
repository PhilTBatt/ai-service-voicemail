// Queues the texts for a call. Called inside the transaction that makes the call ready to
// notify about (process-call's extraction, or a stored voicemail), through that
// transaction's client, so the jobs commit or roll back with the row (BUILD_PLAN Step 5,
// item 3). The jobs wait in the queue until a worker with SMS configured picks them up.
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import type { CallExtraction } from "../core/extraction.ts";
import {
  EMERGENCY_PRIORITY,
  NOTIFY_EMAIL_QUEUE,
  NOTIFY_EMERGENCY_QUEUE,
  NOTIFY_SMS_QUEUE,
} from "./queue.ts";

export interface NotifiableCall {
  tenantId: string;
  callId: string;
  /** From the extraction; null for voicemails and failed extractions. */
  urgency: CallExtraction["urgency"] | null;
}

export type EnqueueNotifications = (client: pg.ClientBase, call: NotifiableCall) => Promise<void>;

export function enqueueNotificationsWith(boss: PgBoss): EnqueueNotifications {
  return async (client, { tenantId, callId, urgency }) => {
    const db = { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
    if (urgency === "emergency") {
      await boss.send(
        NOTIFY_EMERGENCY_QUEUE,
        { tenantId, callId },
        { singletonKey: callId, priority: EMERGENCY_PRIORITY, db },
      );
    }
    await boss.send(NOTIFY_SMS_QUEUE, { tenantId, callId }, { singletonKey: callId, db });
    await boss.send(NOTIFY_EMAIL_QUEUE, { tenantId, callId }, { singletonKey: callId, db });
  };
}
