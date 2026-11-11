// Every business this person can see. Admins see all of them, owners their own, and the
// reseller sees the list with call counts but can't open a business (the API refuses).
import { ONBOARDING_LABELS, type MeView, type TenantListView } from "@callmate/shared";
import { useState } from "react";
import { Link } from "react-router";
import { useApi, useLoad } from "../api.ts";
import {
  Avatar,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  PageHeader,
  Stat,
  TextField,
} from "../design/components.tsx";
import { Building, CircleCheck, Hourglass, PhoneIncoming } from "../design/icons.ts";
import { billingSummary, humanise, statusDisplay } from "../format.ts";
import { SignupLinkPanel } from "../signup-link-panel.tsx";
import { StatusBadge } from "../ui.tsx";

export function TenantsPage({ me }: { me: MeView }) {
  const { api } = useApi();
  const list = useLoad(() => api<TenantListView>("/tenants"), "tenants");
  const [search, setSearch] = useState("");
  const canOpen = me.role !== "reseller";
  const title = me.role === "owner" ? "Your businesses" : "Businesses";

  if (list.status === "loading") {
    return (
      <div className="stack stack-lg">
        <PageHeader title={title} />
        <Loading label="Loading businesses…" lines={5} />
      </div>
    );
  }
  if (list.status === "error") return <ErrorNote error={list.error} retry={list.reload} />;

  const { tenants } = list.data;
  const wanted = search.trim().toLowerCase();
  const shown = wanted
    ? tenants.filter((tenant) => tenant.businessName.toLowerCase().includes(wanted))
    : tenants;
  const count = (status: string) => tenants.filter((tenant) => tenant.status === status).length;
  const callsIn30Days = tenants.reduce((sum, tenant) => sum + tenant.calls.last30Days, 0);

  return (
    <div className="stack stack-lg">
      <PageHeader
        title={title}
        description={
          me.role === "owner"
            ? undefined
            : `${tenants.length} ${tenants.length === 1 ? "business" : "businesses"} on AnswerMate.`
        }
        actions={
          tenants.length > 5 && (
            <TextField
              label="Find a business"
              hideLabel
              type="search"
              placeholder="Find a business"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )
        }
      />

      {me.role !== "owner" && tenants.length > 0 && (
        <div className="grid grid-stats">
          <Stat icon={Building} label="Businesses" value={tenants.length} />
          <Stat icon={CircleCheck} label="Answering" value={count("live")} tone="success" />
          <Stat icon={Hourglass} label="Setting up" value={count("onboarding")} tone="info" />
          <Stat icon={PhoneIncoming} label="Calls in 30 days" value={callsIn30Days} />
        </div>
      )}

      <SignupLinkPanel me={me} />

      <Card flush>
        {tenants.length === 0 ? (
          <EmptyState icon={Building} title="No businesses yet">
            {me.role === "owner"
              ? "Once your business is set up, it appears here."
              : "Make a signup link above and send it to a tradesperson."}
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState icon={Building} title="No business matches">
            Nothing is called "{search.trim()}".
          </EmptyState>
        ) : (
          <ul className="list list-divided">
            {shown.map((tenant) => (
              <li key={tenant.id} className="list-item">
                <div className="list-item-main">
                  <Avatar
                    name={tenant.businessName}
                    tone={statusDisplay(tenant.status).tone}
                    square
                  />
                  <div className="stack stack-xs">
                    <h3 className="row-title">
                      {canOpen ? (
                        <Link to={`/tenants/${tenant.id}`}>{tenant.businessName}</Link>
                      ) : (
                        tenant.businessName
                      )}
                    </h3>
                    <div className="cluster text-sm muted">
                      <span>{humanise(tenant.trade)}</span>
                      <StatusBadge status={tenant.status} />
                      {tenant.status === "onboarding" && tenant.onboardingState !== "live" && (
                        <span>{ONBOARDING_LABELS[tenant.onboardingState]}</span>
                      )}
                    </div>
                    <p className="text-sm muted">{billingSummary(tenant.billing)}</p>
                  </div>
                </div>
                <div className="list-item-aside stack stack-xs">
                  <span className="num">
                    <strong>{tenant.calls.last30Days}</strong>{" "}
                    <span className="muted text-sm">
                      {tenant.calls.last30Days === 1 ? "call" : "calls"} in 30 days
                    </span>
                  </span>
                  <span className="muted text-sm num">{tenant.calls.total} in total</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
