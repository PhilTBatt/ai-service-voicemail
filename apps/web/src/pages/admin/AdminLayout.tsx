// Phil's Admin section: one page per job, with tabs across the top. The API answers these only
// for the admin role; these pages are just views. Each page is loaded only when it's opened
// (App.tsx), so a tradesperson's phone never downloads them.
import { Outlet } from "react-router";
import { PageHeader, Tabs } from "../../design/components.tsx";

export const ADMIN_TABS = [
  { to: "/admin", label: "Overview", exact: true },
  { to: "/admin/billing", label: "Billing" },
  { to: "/admin/leaving", label: "Leaving" },
  { to: "/admin/usage", label: "Usage and costs" },
  { to: "/admin/design", label: "Components" },
] as const;

export function AdminLayout() {
  return (
    <div className="stack stack-lg">
      <div className="stack">
        <PageHeader
          title="Admin"
          description="The whole service: its health, money and businesses."
        />
        <Tabs label="Admin pages" items={ADMIN_TABS} />
      </div>
      <Outlet />
    </div>
  );
}
