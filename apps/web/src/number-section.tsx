// The business's AnswerMate number on the Account tab, and, for the admin only, finding and
// buying one when there isn't one yet. Buying is a real purchase that costs money every month,
// so it's behind a confirmation here, and the API refuses it unless the server allows purchases.
import type { AvailableNumbersView, ProvisionedNumberView, TenantView } from "@callmate/shared";
import { useState } from "react";
import { asError, useApi } from "./api.ts";
import { Alert, Button, Card, ErrorNote, TextField } from "./design/components.tsx";
import { useConfirm } from "./design/dialog.tsx";
import { Phone } from "./design/icons.ts";
import { formatPence, formatPhone } from "./format.ts";

export function NumberSection({
  tenant,
  isAdmin,
  onBought,
}: {
  tenant: TenantView;
  isAdmin: boolean;
  onBought: () => void;
}) {
  if (tenant.number) {
    return (
      <Card icon={Phone} title="Your AnswerMate number">
        <p className="big-number">{formatPhone(tenant.number)}</p>
        <p className="muted text-sm">Calls you divert from your own phone come to this number.</p>
      </Card>
    );
  }
  return (
    <Card icon={Phone} title="Your AnswerMate number">
      <p className="muted">No number yet.</p>
      {/* Not for a business that has left: the API refuses, as it would never be released. */}
      {isAdmin && ["onboarding", "live", "paused", "demo"].includes(tenant.status) && (
        <BuyNumber tenantId={tenant.id} onBought={onBought} />
      )}
    </Card>
  );
}

function BuyNumber({ tenantId, onBought }: { tenantId: string; onBought: () => void }) {
  const { api } = useApi();
  const confirm = useConfirm();
  const [digits, setDigits] = useState("");
  const [offers, setOffers] = useState<AvailableNumbersView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ contains: digits.replace(/\s/g, "") });
      setOffers(await api<AvailableNumbersView>(`/admin/numbers/available?${query}`));
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  const buy = async (number: string) => {
    const price =
      offers?.monthlyPence != null
        ? `${formatPence(offers.monthlyPence)} a month`
        : "a monthly fee";
    const yes = await confirm({
      title: `Buy ${formatPhone(number)}?`,
      body: `It costs ${price}. This is a real purchase from Twilio, charged to the account straight away, and calls to it will reach this business's assistant.`,
      confirmLabel: "Buy this number",
      tone: "danger",
    });
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      await api<ProvisionedNumberView>(`/admin/tenants/${tenantId}/number`, {
        method: "POST",
        body: { number, confirm: true },
      });
      onBought();
    } catch (caught) {
      setError(asError(caught));
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <TextField
          label="Number contains"
          hint="An area code like 0113, or leave empty."
          inputMode="numeric"
          value={digits}
          onChange={(event) => setDigits(event.target.value)}
        />
        <Button type="submit" variant="secondary" loading={busy}>
          Find numbers
        </Button>
      </form>
      {offers && !offers.purchasesEnabled && (
        <Alert tone="info">
          <p>
            Buying is switched off on this server (TWILIO_PURCHASES_ENABLED), so you can look but
            not buy.
          </p>
        </Alert>
      )}
      {offers && offers.numbers.length === 0 && <p className="muted">No numbers match.</p>}
      {offers && offers.numbers.length > 0 && (
        <ul className="list list-divided card">
          {offers.numbers.map((offer) => (
            <li key={offer.number} className="list-item">
              <span>
                <strong className="num">{formatPhone(offer.number)}</strong>{" "}
                <span className="muted text-sm">{offer.locality ?? offer.region ?? ""}</span>
              </span>
              <Button
                size="sm"
                disabled={busy || !offers.purchasesEnabled}
                onClick={() => void buy(offer.number)}
              >
                Buy
                {offers.monthlyPence != null && ` (${formatPence(offers.monthlyPence)}/month)`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorNote error={error} />}
    </div>
  );
}
