// Onboarding against the database (BUILD_PLAN Step 11): reads the facts the rules in
// core/onboarding.ts need, and moves a business forward when they allow it. Everything runs
// inside the business's own transaction (withTenant), so row-level security applies; the row is
// locked while a step is taken, so two clicks can't both move it on.
import {
  LEGAL_DOCUMENT_TYPES,
  LEGAL_DOCUMENTS,
  ONBOARDING_LABELS,
  ONBOARDING_STATES,
  type OnboardingState,
  type OnboardingView,
} from "@callmate/shared";
import type pg from "pg";
import { canAdvance, nextState, type OnboardingFacts } from "../core/onboarding.ts";
import { withTenant } from "./tenant.ts";

interface FactsRow {
  onboarding_state: OnboardingState;
  status: string;
  is_pilot: boolean;
  is_test: boolean;
  documents_accepted: number;
  accepted_versions: Record<string, string>;
  has_number: boolean;
  has_profile: boolean;
  has_contact_name: boolean;
  has_mobile: boolean;
  agent_synced: boolean;
  has_call: boolean;
}

async function loadFacts(
  client: pg.ClientBase,
  tenantId: string,
  lock: boolean,
): Promise<{ state: OnboardingState; status: string; facts: OnboardingFacts } | null> {
  const row = (
    await client.query<FactsRow>(
      `SELECT t.onboarding_state, t.status, t.is_pilot, t.is_test,
              (SELECT coalesce(json_object_agg(latest.document_type, latest.document_version), '{}')
               FROM (SELECT DISTINCT ON (document_type) document_type, document_version
                     FROM terms_acceptances a WHERE a.tenant_id = t.id
                     ORDER BY document_type, accepted_at DESC) latest) AS accepted_versions,
              (SELECT count(DISTINCT document_type)::int FROM terms_acceptances a
               WHERE a.tenant_id = t.id) AS documents_accepted,
              EXISTS (SELECT 1 FROM phone_numbers n
                      WHERE n.tenant_id = t.id AND n.status = 'active') AS has_number,
              p.version IS NOT NULL AS has_profile,
              t.contact_name IS NOT NULL AS has_contact_name,
              t.notification_mobile IS NOT NULL AS has_mobile,
              p.synced_at IS NOT NULL AS agent_synced,
              -- The test call proves the divert, so only a call after the instructions counts.
              EXISTS (SELECT 1 FROM calls c WHERE c.tenant_id = t.id
                        AND c.started_at > (SELECT min(a.created_at) FROM audit_log a
                                            WHERE a.tenant_id = t.id
                                              AND a.action = 'onboarding.advanced'
                                              AND a.details->>'to' = 'divert_instructions_sent')
                     ) AS has_call
       FROM tenants t
       LEFT JOIN LATERAL (SELECT version, synced_at FROM agent_profiles
                          WHERE tenant_id = t.id ORDER BY version DESC LIMIT 1) p ON true
       WHERE t.id = $1
       ${lock ? "FOR UPDATE OF t" : ""}`,
      [tenantId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    state: row.onboarding_state,
    status: row.status,
    facts: {
      termsAccepted: row.documents_accepted === 3, // terms, DPA and privacy notice
      // Each accepted version is the current one, the current one is solicitor-approved, and
      // it isn't a placeholder (approving one by mistake mustn't approve every placeholder
      // acceptance with it).
      documentsApproved: LEGAL_DOCUMENT_TYPES.every(
        (type) =>
          row.accepted_versions[type] === LEGAL_DOCUMENTS[type].version &&
          LEGAL_DOCUMENTS[type].approved &&
          !/placeholder/i.test(LEGAL_DOCUMENTS[type].version),
      ),
      isTest: row.is_test,
      paymentReady: false, // Step 12
      isPilot: row.is_pilot,
      hasNumber: row.has_number,
      profileComplete: row.has_profile && row.has_contact_name && row.has_mobile,
      agentSynced: row.agent_synced,
      testCallReceived: row.has_call,
    },
  };
}

/** The business's checklist, or null if there's no such business. */
export async function onboardingStatus(
  pool: pg.Pool,
  tenantId: string,
): Promise<OnboardingView | null> {
  return withTenant(pool, tenantId, async (client) => {
    const loaded = await loadFacts(client, tenantId, false);
    if (!loaded) return null;
    const { state, facts } = loaded;
    const position = ONBOARDING_STATES.indexOf(state);
    const next = nextState(state);
    const verdict = next ? canAdvance(state, next, facts) : null;
    return {
      state,
      isPilot: facts.isPilot,
      steps: ONBOARDING_STATES.map((step, index) => ({
        state: step,
        label: ONBOARDING_LABELS[step],
        done: index <= position,
      })),
      next:
        next && verdict
          ? {
              state: next,
              label: ONBOARDING_LABELS[next],
              allowed: verdict.ok,
              reason: verdict.ok ? null : verdict.reason,
            }
          : null,
      checks: [
        { label: "Terms, DPA and privacy notice accepted", ok: facts.termsAccepted },
        {
          label: "Accepted documents are the solicitor-approved ones (not placeholders)",
          ok: facts.documentsApproved,
        },
        { label: "Test business (may go live on placeholder documents)", ok: facts.isTest },
        { label: "Payment set up (billing comes in Step 12)", ok: facts.paymentReady },
        { label: "Pilot (free, so no payment needed)", ok: facts.isPilot },
        { label: "Has an AnswerMate number", ok: facts.hasNumber },
        { label: "Assistant details, name and mobile", ok: facts.profileComplete },
        { label: "Assistant is using the latest details", ok: facts.agentSynced },
        { label: "A call has reached the number", ok: facts.testCallReceived },
      ],
    };
  });
}

export type AdvanceResult =
  | { outcome: "advanced"; state: OnboardingState }
  | { outcome: "refused"; reason: string }
  | { outcome: "not-found" };

/**
 * Moves the business to `to`, if the rules allow it now. Going live also switches the business
 * on (status 'live'), which only a business that's still onboarding can do. Audited.
 */
export async function advanceOnboarding(
  pool: pg.Pool,
  tenantId: string,
  to: OnboardingState,
  /** Null when the system took the step (going live after the test call). */
  actorUserId: string | null,
): Promise<AdvanceResult> {
  return withTenant(pool, tenantId, async (client) => {
    const loaded = await loadFacts(client, tenantId, true);
    if (!loaded) return { outcome: "not-found" };
    const verdict = canAdvance(loaded.state, to, loaded.facts);
    if (!verdict.ok) return { outcome: "refused", reason: verdict.reason };
    if (to === "live" && loaded.status !== "onboarding") {
      return {
        outcome: "refused",
        reason: `Only a business that's onboarding can go live; this one is ${loaded.status}`,
      };
    }
    await client.query(
      `UPDATE tenants SET onboarding_state = $2,
              status = CASE WHEN $2 = 'live' THEN 'live' ELSE status END
       WHERE id = $1`,
      [tenantId, to],
    );
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'onboarding.advanced', $3)",
      [
        tenantId,
        actorUserId,
        { via: actorUserId ? "dashboard" : "automatic", from: loaded.state, to },
      ],
    );
    return { outcome: "advanced", state: to };
  });
}

/** Marks a business as a free pilot, or not. Audited. Returns false if there's no such business. */
export async function setPilot(
  pool: pg.Pool,
  tenantId: string,
  isPilot: boolean,
  actorUserId: string,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const updated = await client.query("UPDATE tenants SET is_pilot = $2 WHERE id = $1", [
      tenantId,
      isPilot,
    ]);
    if (updated.rowCount !== 1) return false;
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)",
      [tenantId, actorUserId, isPilot ? "pilot.on" : "pilot.off", { via: "dashboard" }],
    );
    return true;
  });
}

/**
 * A call reached a business that's waiting for its test call: that's the step done. Runs in the
 * transaction that stores the call. True when it moved the business on, so the caller can queue
 * the go-live job through the same transaction.
 */
export async function noteTestCall(client: pg.ClientBase, tenantId: string): Promise<boolean> {
  const moved = await client.query(
    "UPDATE tenants SET onboarding_state = 'test_call_received' WHERE id = $1 AND onboarding_state = 'divert_instructions_sent'",
    [tenantId],
  );
  if (moved.rowCount !== 1) return false;
  await client.query(
    "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, NULL, 'onboarding.advanced', $2)",
    [tenantId, { via: "test call", from: "divert_instructions_sent", to: "test_call_received" }],
  );
  return true;
}
