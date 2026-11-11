// Finds agent calls whose call-ended webhook never reached the API (the API was down, the
// tunnel dropped, the platform gave up retrying) and stores them through the normal path.
// Also completes the provisional rows a mid-call emergency opens. Runs on a schedule; safe
// to repeat, because recordCallEnded treats a finished call as a duplicate.
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { recordCallEnded } from "../db/calls.ts";
import { findCompletedProviderCallIds, type AdminPool } from "../db/cross-tenant.ts";
import { logger } from "../logger.ts";
import type { VoiceProvider } from "../providers/voice.ts";

export interface ReconcileCallsDeps {
  pool: pg.Pool;
  /** Only used to ask which calls are already complete, in one query across tenants. */
  admin: AdminPool;
  boss: PgBoss;
  voice: VoiceProvider;
  now?: () => Date;
  lookbackHours?: number;
}

export interface ReconcileCallsCounts {
  listed: number;
  alreadyStored: number;
  stored: number;
  duplicate: number;
  unknownNumber: number;
  /** Calls that couldn't be stored this run (logged; the next run tries again). */
  failed: number;
}

export async function reconcileCalls({
  pool,
  admin,
  boss,
  voice,
  now = () => new Date(),
  lookbackHours = 24,
}: ReconcileCallsDeps): Promise<ReconcileCallsCounts> {
  const since = new Date(now().getTime() - lookbackHours * 3600_000);
  const events = await voice.listEndedCalls({ since });
  const complete = await findCompletedProviderCallIds(
    admin,
    events.map((e) => e.providerCallId),
  );
  const counts: ReconcileCallsCounts = {
    listed: events.length,
    alreadyStored: 0,
    stored: 0,
    duplicate: 0,
    unknownNumber: 0,
    failed: 0,
  };
  for (const event of events) {
    if (complete.has(event.providerCallId)) {
      counts.alreadyStored += 1;
      continue;
    }
    // One call that can't be stored mustn't stop the others behind it in the list, run after
    // run: it's logged, counted and tried again next time.
    try {
      const { outcome } = await recordCallEnded(pool, boss, event);
      if (outcome === "stored") counts.stored += 1;
      else if (outcome === "duplicate") counts.duplicate += 1;
      else counts.unknownNumber += 1;
    } catch (error) {
      counts.failed += 1;
      logger.warn("Couldn't store a reconciled call: tried again next run", {
        providerCallId: event.providerCallId,
        error,
      });
    }
  }
  // Counts only: never the numbers or transcripts.
  logger.info("Call reconciliation finished", { ...counts, lookbackHours });
  return counts;
}
