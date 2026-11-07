// Every business this person can see. Admins see all of them, owners their own, and the
// reseller sees the list with call counts but can't open a business (the API refuses).
import type { MeView, TenantListView } from "@callmate/shared";
import { Link } from "react-router";
import { useApi, useLoad } from "../api.ts";
import { humanise } from "../format.ts";
import { ErrorNote, StatusBadge } from "../ui.tsx";

export function TenantsPage({ me }: { me: MeView }) {
  const { api } = useApi();
  const list = useLoad(() => api<TenantListView>("/tenants"), "tenants");
  const canOpen = me.role !== "reseller";

  if (list.status === "loading") return <p className="muted">Loading businesses…</p>;
  if (list.status === "error") return <ErrorNote error={list.error} retry={list.reload} />;

  const { tenants } = list.data;
  return (
    <>
      <h1>Businesses</h1>
      {tenants.length === 0 && <p className="muted">No businesses yet.</p>}
      <ul className="list">
        {tenants.map((tenant) => {
          const name = canOpen ? (
            <Link to={`/tenants/${tenant.id}`}>{tenant.businessName}</Link>
          ) : (
            tenant.businessName
          );
          return (
            <li key={tenant.id} className="card row">
              <div>
                <h2 className="row-title">{name}</h2>
                <p className="muted">
                  {humanise(tenant.trade)} · <StatusBadge status={tenant.status} />
                </p>
              </div>
              <p className="counts">
                <strong>{tenant.calls.last30Days}</strong> calls in 30 days
                <br />
                <span className="muted">{tenant.calls.total} in total</span>
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}
