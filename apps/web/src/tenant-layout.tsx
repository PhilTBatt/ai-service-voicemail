// Every page about one business sits inside this: it loads the business once, shows its
// header (name, trade, status, number) and any documents waiting to be accepted, then the page.
// Pages get the business from useTenant() instead of each loading it again, and call
// reload() after changing it, so the header and the page agree.
import { LEGAL_DOCUMENTS, type MeView, type TenantView } from "@callmate/shared";
import { Link, Outlet, useMatch, useOutletContext, useParams } from "react-router";
import { useApi, useLoad } from "./api.ts";
import { Alert, Avatar, ErrorNote, Loading } from "./design/components.tsx";
import { Phone } from "./design/icons.ts";
import { formatPhone, humanise, statusDisplay } from "./format.ts";
import { StatusBadge } from "./ui.tsx";

export interface TenantContext {
  me: MeView;
  tenant: TenantView;
  /** Loads the business again (after a change), keeping the page on screen meanwhile. */
  reload: () => void;
}

export function useTenant(): TenantContext {
  return useOutletContext<TenantContext>();
}

export function TenantLayout({ me }: { me: MeView }) {
  const { tenantId = "" } = useParams();
  const { api } = useApi();
  const tenant = useLoad(() => api<TenantView>(`/tenants/${tenantId}`), tenantId);
  // A call has its own header: the caller, not the business.
  const onCall = useMatch("/tenants/:tenantId/calls/:callId") !== null;

  if (tenant.status === "loading") return <Loading lines={4} />;
  if (tenant.status === "error") return <ErrorNote error={tenant.error} retry={tenant.reload} />;

  return (
    <div className="stack stack-lg">
      {!onCall && <BusinessHeader tenant={tenant.data} />}
      <DocumentsReminder me={me} tenant={tenant.data} />
      <Outlet
        context={{ me, tenant: tenant.data, reload: tenant.reload } satisfies TenantContext}
      />
    </div>
  );
}

function BusinessHeader({ tenant }: { tenant: TenantView }) {
  return (
    <header className="business-header">
      <div className="business-identity">
        <Avatar
          name={tenant.businessName}
          tone={statusDisplay(tenant.status).tone}
          size="lg"
          square
        />
        <div>
          <h1 className="page-title">{tenant.businessName}</h1>
          <div className="business-meta">
            <span>{humanise(tenant.trade)}</span>
            <StatusBadge status={tenant.status} />
            {tenant.number && (
              <span className="business-number">
                <Phone size={14} />
                {formatPhone(tenant.number)}
              </span>
            )}
          </div>
        </div>
      </div>
    </header>
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
      <Alert tone="info">
        <p>
          This business hasn't accepted the current {listTitles(tenant)}, so it can't go live until
          its owner does.
        </p>
      </Alert>
    );
  }
  return (
    <Alert
      tone="warning"
      title="Documents to accept"
      actions={
        <Link to={`/tenants/${tenant.id}/settings#documents`} className="btn btn-primary btn-sm">
          Read and accept
        </Link>
      }
    >
      <p>Please read and accept the current {listTitles(tenant)}.</p>
    </Alert>
  );
}
