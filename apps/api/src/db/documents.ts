// A business's legal documents (BUILD_PLAN Step 11): which version of each it last accepted,
// and accepting the current ones. When the solicitor's documents replace the placeholders, or a
// document changes later, its version changes (packages/shared/src/signup.ts) and every
// business has to accept it again: the go-live rule already refuses one that hasn't, and the
// dashboard asks the owner. terms_acceptances is append-only, so the latest row is what counts
// and the history stays.
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_TYPES,
  documentsToAccept,
  type AcceptDocumentsInput,
  type DocumentView,
  type LegalDocumentType,
} from "@callmate/shared";
import type pg from "pg";
import type { EnqueueOnboarding } from "../jobs/onboarding.ts";
import { withTenant } from "./tenant.ts";

export type LatestAcceptances = Partial<
  Record<LegalDocumentType, { version: string; acceptedAt: Date }>
>;

/** The latest acceptance of each document, inside the business's own tenant context. */
export async function latestAcceptances(
  client: pg.ClientBase,
  tenantId: string,
): Promise<LatestAcceptances> {
  const { rows } = await client.query<{
    document_type: LegalDocumentType;
    document_version: string;
    accepted_at: Date;
  }>(
    `SELECT DISTINCT ON (document_type) document_type, document_version, accepted_at
     FROM terms_acceptances WHERE tenant_id = $1
     ORDER BY document_type, accepted_at DESC`,
    [tenantId],
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.document_type,
      { version: row.document_version, acceptedAt: row.accepted_at },
    ]),
  );
}

export function versionsOf(latest: LatestAcceptances) {
  return Object.fromEntries(
    Object.entries(latest).map(([type, accepted]) => [type, accepted.version]),
  );
}

/** Every document, the current version, and where the business stands with each. */
export function presentDocuments(latest: LatestAcceptances): DocumentView[] {
  const outstanding = new Set(documentsToAccept(versionsOf(latest)));
  return LEGAL_DOCUMENT_TYPES.map((type) => {
    const document = LEGAL_DOCUMENTS[type];
    return {
      type,
      title: document.title,
      version: document.version,
      summary: document.summary,
      url: document.url ?? null,
      approved: document.approved,
      acceptedVersion: latest[type]?.version ?? null,
      acceptedAt: latest[type]?.acceptedAt.toISOString() ?? null,
      needsAccepting: outstanding.has(type),
    };
  });
}

export type AcceptOutcome =
  /** Recorded, with the documents that needed it (none if all were already accepted). */
  | { outcome: "accepted"; recorded: LegalDocumentType[]; latest: LatestAcceptances }
  /** A version the owner saw isn't the current one any more: nothing recorded. */
  | { outcome: "stale"; stale: LegalDocumentType[] };

/**
 * Records the owner's acceptance of the versions they saw, if each is still current. One
 * transaction: the acceptance rows, an audit row naming who, and (when anything was recorded)
 * a go-live check, since accepting may be the last thing a business was waiting on.
 */
export async function acceptDocuments(
  pool: pg.Pool,
  tenantId: string,
  userId: string,
  { versions }: AcceptDocumentsInput,
  enqueueOnboarding?: EnqueueOnboarding,
): Promise<AcceptOutcome> {
  const offered = LEGAL_DOCUMENT_TYPES.filter((type) => versions[type] !== undefined);
  const stale = offered.filter((type) => versions[type] !== LEGAL_DOCUMENTS[type].version);
  if (stale.length > 0) return { outcome: "stale", stale };

  return withTenant(pool, tenantId, async (client) => {
    // Two clicks at once record one acceptance, not two.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`documents:${tenantId}`]);
    const before = await latestAcceptances(client, tenantId);
    const recorded = offered.filter(
      (type) => before[type]?.version !== LEGAL_DOCUMENTS[type].version,
    );
    for (const type of recorded) {
      await client.query(
        `INSERT INTO terms_acceptances (tenant_id, document_type, document_version, accepted_by)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, type, LEGAL_DOCUMENTS[type].version, userId],
      );
    }
    if (recorded.length > 0) {
      await client.query(
        "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'documents.accepted', $3)",
        [
          tenantId,
          userId,
          {
            documents: recorded.map((type) => ({ type, version: LEGAL_DOCUMENTS[type].version })),
          },
        ],
      );
      await enqueueOnboarding?.({ tenantId, action: "go-live" }, client);
    }
    return { outcome: "accepted", recorded, latest: await latestAcceptances(client, tenantId) };
  });
}
