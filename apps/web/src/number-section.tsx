// The business's AnswerMate number on the Account tab, and, for the admin only, finding and
// buying one when there isn't one yet. Buying is a real purchase that costs money every month,
// so it's behind a confirmation here, and the API refuses it unless the server allows purchases.
import type { AvailableNumbersView, ProvisionedNumberView, TenantView } from "@callmate/shared";
import { useState } from "react";
import { asError, useApi } from "./api.ts";
import { formatPence, formatPhone } from "./format.ts";
import { ErrorNote } from "./ui.tsx";

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
      <section className="card">
        <h2>Your AnswerMate number</h2>
        <p className="big-number">{formatPhone(tenant.number)}</p>
        <p className="hint">Calls you divert from your own phone come to this number.</p>
      </section>
    );
  }
  return (
    <section className="card">
      <h2>Your AnswerMate number</h2>
      <p>No number yet.</p>
      {isAdmin && <BuyNumber tenantId={tenant.id} onBought={onBought} />}
    </section>
  );
}

function BuyNumber({ tenantId, onBought }: { tenantId: string; onBought: () => void }) {
  const { api } = useApi();
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
    const question = `Buy ${formatPhone(number)} for ${price}? This is a real purchase from Twilio, charged to the account straight away, and calls to it will reach this business's assistant.`;
    if (!window.confirm(question)) return;
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
    <div className="buy-number">
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          Number contains (an area code like 0113, or leave empty)
          <input
            inputMode="numeric"
            value={digits}
            onChange={(event) => setDigits(event.target.value)}
          />
        </label>
        <button type="submit" className="secondary" disabled={busy}>
          Find numbers
        </button>
      </form>
      {offers && !offers.purchasesEnabled && (
        <p className="card notice">
          Buying is switched off on this server (TWILIO_PURCHASES_ENABLED), so you can look but not
          buy.
        </p>
      )}
      {offers && offers.numbers.length === 0 && <p className="muted">No numbers match.</p>}
      {offers && offers.numbers.length > 0 && (
        <ul className="list">
          {offers.numbers.map((offer) => (
            <li key={offer.number} className="row offer">
              <span>
                <strong>{formatPhone(offer.number)}</strong>{" "}
                <span className="muted">{offer.locality ?? offer.region ?? ""}</span>
              </span>
              <button
                type="button"
                disabled={busy || !offers.purchasesEnabled}
                onClick={() => void buy(offer.number)}
              >
                Buy
                {offers.monthlyPence != null && ` (${formatPence(offers.monthlyPence)}/month)`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorNote error={error} />}
    </div>
  );
}
