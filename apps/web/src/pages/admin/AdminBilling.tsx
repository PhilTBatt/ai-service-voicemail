// Billing at a glance (Step 12): this month's money, and the charges that need a person. A
// failed payment can be collected again here, as GoCardless's own retry of it; a cancelled one
// as a new payment for the month, while the business has a Direct Debit to take it from.
import type { AdminBillingView } from "@callmate/shared";
import { useState } from "react";
import { Link } from "react-router";
import { asError, useApi, useLoad } from "../../api.ts";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  Stat,
} from "../../design/components.tsx";
import { useConfirm } from "../../design/dialog.tsx";
import { CircleCheck, Hourglass, Receipt, RotateCcw, TriangleAlert } from "../../design/icons.ts";
import { useToast } from "../../design/toast.tsx";
import { CHARGE_STATUS_LABELS, chargeTone, formatPence, humanise } from "../../format.ts";
import { addDays, formatDate } from "../../time.ts";

export function AdminBilling() {
  const { api } = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const billing = useLoad(() => api<AdminBillingView>("/admin/billing"), "admin-billing");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  if (billing.status === "loading") return <Loading label="Loading billing…" lines={4} />;
  if (billing.status === "error") return <ErrorNote error={billing.error} retry={billing.reload} />;
  const { thisMonth, attention, available, environment } = billing.data;

  const collectAgain = async (chargeId: string, businessName: string, status: string) => {
    const yes = await confirm({
      title: `Collect ${businessName}'s payment again?`,
      // GoCardless can retry a failed payment, but not a cancelled one: that month gets a new
      // payment instead, so the two say what will actually happen.
      body:
        status === "cancelled"
          ? "The payment was cancelled, and GoCardless can't retry a cancelled one, so this makes a new payment for the same month from the business's Direct Debit."
          : "GoCardless retries the same payment from the business's Direct Debit. It can do this up to three times.",
      confirmLabel: "Collect again",
    });
    if (!yes) return;
    setBusy(chargeId);
    setError(null);
    try {
      await api(`/admin/charges/${chargeId}/collect-again`, { method: "POST", body: {} });
      toast({ title: "Asked GoCardless to collect it again" });
      billing.reload();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack stack-lg">
      {environment === "sandbox" && (
        <Alert tone="danger" title="Payments are on GoCardless's sandbox: no real money moves.">
          <p>Before the first paying customer, switch to the live account (RUNBOOK section 17).</p>
        </Alert>
      )}
      <div className="stack stack-sm">
        <div className="grid grid-stats">
          <Stat
            icon={CircleCheck}
            label="Collected this month"
            value={formatPence(thisMonth.collectedPence)}
            tone="success"
          />
          <Stat
            icon={Hourglass}
            label="Being collected"
            value={formatPence(thisMonth.collectingPence)}
            tone="info"
          />
          <Stat
            icon={TriangleAlert}
            label="Not collected"
            value={formatPence(thisMonth.problemPence)}
            tone={thisMonth.problemPence > 0 ? "danger" : undefined}
          />
        </div>
        <p className="muted text-sm">
          By the day each month was charged. Prices before VAT unless VAT is set up.
        </p>
      </div>

      <Card
        icon={Receipt}
        tone={attention.length > 0 ? "danger" : undefined}
        title="Payments that need you"
        description={`Nothing is switched off for not paying: suspending a business is on its Account page. "Owed, no Direct Debit" is collected by itself once the business sets one up.`}
        flush
      >
        {attention.length === 0 ? (
          <EmptyState icon={CircleCheck} title="No payments need you." />
        ) : (
          <div className="table-wrap">
            <table className="table table-stack">
              <thead>
                <tr>
                  <th>Business</th>
                  <th>Month</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {attention.map((charge) => (
                  <tr key={charge.chargeId}>
                    <td data-label="">
                      <Link to={`/tenants/${charge.tenantId}/settings#billing`}>
                        <strong>{charge.businessName}</strong>
                      </Link>
                    </td>
                    <td data-label="Month">
                      {formatDate(charge.periodStart)} to{" "}
                      {formatDate(addDays(charge.periodEnd, -1))}
                    </td>
                    <td data-label="Amount" className="num">
                      {formatPence(charge.totalPence)}
                    </td>
                    <td data-label="Status">
                      <div className="stack stack-xs">
                        <span>
                          <Badge tone={chargeTone(charge.status)}>
                            {CHARGE_STATUS_LABELS[charge.status] ?? charge.status}
                          </Badge>
                        </span>
                        {charge.failureReason && (
                          <span className="muted text-xs">{humanise(charge.failureReason)}</span>
                        )}
                      </div>
                    </td>
                    <td data-label="">
                      {charge.canCollectAgain && available && (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={RotateCcw}
                          loading={busy === charge.chargeId}
                          disabled={busy !== null}
                          onClick={() =>
                            void collectAgain(charge.chargeId, charge.businessName, charge.status)
                          }
                        >
                          Collect again
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {error && <ErrorNote error={error} />}
    </div>
  );
}
