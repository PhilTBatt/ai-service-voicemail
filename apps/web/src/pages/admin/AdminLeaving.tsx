// Businesses that are leaving (BUILD_PLAN Step 13). For 30 days their callers hear "service has
// ended"; after that their number can be released, which is a live action and final. Once it
// has gone, their data can be deleted, which is final too, so the business's name is typed first.
import type { CancellationsView, DataDeletionView, ReleasedNumberView } from "@callmate/shared";
import { useState } from "react";
import { Link } from "react-router";
import { asError, useApi, useLoad } from "../../api.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
} from "../../design/components.tsx";
import { useConfirm, useConfirmTyped } from "../../design/dialog.tsx";
import { Hourglass, Phone, Trash, Users } from "../../design/icons.ts";
import { useToast } from "../../design/toast.tsx";
import { formatPhone } from "../../format.ts";
import { formatUkDateTime } from "../../time.ts";

export function AdminLeaving() {
  const { api } = useApi();
  const confirm = useConfirm();
  const confirmTyped = useConfirmTyped();
  const toast = useToast();
  const leaving = useLoad(() => api<CancellationsView>("/admin/cancellations"), "cancellations");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [queued, setQueued] = useState<string[]>([]);

  if (leaving.status === "loading") return <Loading label="Loading cancellations…" />;
  if (leaving.status === "error") return <ErrorNote error={leaving.error} retry={leaving.reload} />;

  const release = async (tenantId: string, businessName: string, number: string | null) => {
    const yes = await confirm({
      title: number ? `Release ${formatPhone(number)}?` : `Close ${businessName}?`,
      body: `For ${businessName}. The number goes back to Twilio for good, and callers to it stop hearing the "service has ended" message.`,
      confirmLabel: number ? "Release number" : "Close",
      tone: "danger",
    });
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      await api<ReleasedNumberView>(`/admin/tenants/${tenantId}/release-number`, {
        method: "POST",
        body: { confirm: true },
      });
      toast({ title: number ? "Number released" : "Closed" });
      leaving.reload();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  const deleteData = async (tenantId: string, businessName: string) => {
    const typed = await confirmTyped({
      title: `Delete ${businessName}'s data?`,
      body: (
        <>
          <p>
            This deletes everything AnswerMate holds for {businessName}: calls, recordings,
            transcripts, messages and contact details, here and at Retell and Twilio.
          </p>
          <p>Only the billing totals, the terms they accepted and the account log stay.</p>
          <p>
            <strong>It can't be undone.</strong>
          </p>
        </>
      ),
      requireText: businessName,
      requireLabel: "Type the business's name to delete its data",
      confirmLabel: "Delete data",
      tone: "danger",
    });
    if (typed === null) return;
    setBusy(true);
    setError(null);
    try {
      await api<DataDeletionView>(`/admin/tenants/${tenantId}/delete-data`, {
        method: "POST",
        body: { confirm: true, businessName: typed },
      });
      setQueued((ids) => [...ids, tenantId]);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack stack-lg">
      <p className="muted">
        Callers hear that the service has ended for 30 days after a cancellation. Then the number
        can be released, and after that the business's data deleted.
      </p>
      {error && <ErrorNote error={error} />}
      <Card flush>
        {leaving.data.tenants.length === 0 ? (
          <EmptyState icon={Users} title="Nobody is leaving">
            Businesses that cancel appear here until their data is deleted.
          </EmptyState>
        ) : (
          <ul className="list list-divided">
            {leaving.data.tenants.map((tenant) => (
              <li key={tenant.tenantId} className="list-item">
                <div className="list-item-main">
                  <Avatar name={tenant.businessName} square />
                  <div className="stack stack-xs">
                    <h3 className="row-title">
                      <Link to={`/tenants/${tenant.tenantId}`}>{tenant.businessName}</Link>
                    </h3>
                    <p className="muted text-sm">
                      Cancelled {formatUkDateTime(tenant.cancellationRequestedAt)}
                    </p>
                    <div className="cluster text-sm">
                      {tenant.status === "cancelled" ? (
                        <Badge>Number released, data still held</Badge>
                      ) : tenant.number ? (
                        <Badge icon={Phone}>{formatPhone(tenant.number)}</Badge>
                      ) : (
                        <Badge>No number</Badge>
                      )}
                    </div>
                  </div>
                </div>
                {tenant.status === "cancelled" ? (
                  queued.includes(tenant.tenantId) ? (
                    <Badge tone="info" icon={Hourglass}>
                      Deleting: the worker is on it
                    </Badge>
                  ) : (
                    <Button
                      variant="danger"
                      icon={Trash}
                      disabled={busy}
                      onClick={() => void deleteData(tenant.tenantId, tenant.businessName)}
                    >
                      Delete data
                    </Button>
                  )
                ) : tenant.due ? (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void release(tenant.tenantId, tenant.businessName, tenant.number)
                    }
                  >
                    {tenant.number ? "Release number" : "Close"}
                  </Button>
                ) : (
                  <span className="muted text-sm">
                    From {formatUkDateTime(tenant.releaseDueAt)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
