// The top of every page about one business: its name and status, and tabs for its pages.
import type { MeView, TenantView } from "@callmate/shared";
import { Link, NavLink } from "react-router";
import { humanise } from "./format.ts";
import { StatusBadge } from "./ui.tsx";

export function TenantHeader({ me, tenant }: { me: MeView; tenant: TenantView }) {
  const base = `/tenants/${tenant.id}`;
  // A tradesperson with one business has nowhere to go back to.
  const onlyBusiness = me.role === "owner" && me.tenantIds.length === 1;
  return (
    <>
      {!onlyBusiness && (
        <p>
          <Link to="/">← All businesses</Link>
        </p>
      )}
      <h1>{tenant.businessName}</h1>
      <p className="muted">
        {humanise(tenant.trade)} · <StatusBadge status={tenant.status} />
      </p>
      <nav className="tabs">
        <NavLink to={base} end>
          Calls
        </NavLink>
        <NavLink to={`${base}/profile`}>Assistant</NavLink>
        <NavLink to={`${base}/phone`}>Phone setup</NavLink>
        <NavLink to={`${base}/settings`}>Account</NavLink>
        {me.role === "admin" && <NavLink to={`${base}/onboarding`}>Onboarding</NavLink>}
      </nav>
    </>
  );
}
