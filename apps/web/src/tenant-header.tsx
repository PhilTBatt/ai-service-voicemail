// The top of every page about one business: its name and status, tabs for its pages, and a
// reminder when the business has legal documents to accept.
import { LEGAL_DOCUMENTS, type MeView, type TenantView } from "@callmate/shared";
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
      <DocumentsReminder me={me} tenant={tenant} />
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

/** "Terms of service, Data processing agreement and Privacy notice". */
function listTitles(tenant: TenantView): string {
  const titles = tenant.documentsToAccept.map((type) => LEGAL_DOCUMENTS[type].title);
  return titles.length < 2
    ? (titles[0] ?? "")
    : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)!}`;
}

/**
 * Documents whose current version the business hasn't accepted: new, or changed since. The
 * owner is asked to accept them; an admin is told, since only the owner can.
 */
function DocumentsReminder({ me, tenant }: { me: MeView; tenant: TenantView }) {
  if (tenant.documentsToAccept.length === 0) return null;
  if (me.role !== "owner") {
    return (
      <p className="muted">
        This business hasn't accepted the current {listTitles(tenant)}, so it can't go live until
        its owner does.
      </p>
    );
  }
  return (
    <div className="card error">
      <p>
        Please read and accept the current {listTitles(tenant)}.{" "}
        <Link to={`/tenants/${tenant.id}/settings#documents`}>Read and accept</Link>
      </p>
    </div>
  );
}
