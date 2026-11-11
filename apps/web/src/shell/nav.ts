// What the sidebar offers each person, worked out from who they are and which business is on
// screen. Pure, so it's tested without a browser (nav.test.ts). A new page gets its entry
// here, and only here: there's one navigation, and every screen size uses it.
//
// Hiding an entry is convenience, never security: the API refuses what a role may not see.
import type { MeView } from "@callmate/shared";

/** Which icon the sidebar draws: named here, drawn by AppShell, so this file needs no React. */
export type NavIcon =
  "businesses" | "admin" | "calls" | "assistant" | "phone" | "account" | "onboarding";

export interface NavItem {
  to: string;
  label: string;
  icon: NavIcon;
  /** The address must be exactly `to` to count as this page; otherwise anything under it does. */
  exact?: boolean;
  /** Other addresses that count as this page (a call is part of Calls). */
  alsoUnder?: string[];
}

export interface NavSection {
  heading: string | null;
  items: NavItem[];
}

function businessItems(tenantId: string, isAdmin: boolean): NavItem[] {
  const base = `/tenants/${tenantId}`;
  return [
    { to: base, label: "Calls", icon: "calls", exact: true, alsoUnder: [`${base}/calls`] },
    { to: `${base}/profile`, label: "Assistant", icon: "assistant" },
    { to: `${base}/phone`, label: "Phone setup", icon: "phone" },
    { to: `${base}/settings`, label: "Account", icon: "account" },
    ...(isAdmin
      ? [{ to: `${base}/onboarding`, label: "Onboarding", icon: "onboarding" as const }]
      : []),
  ];
}

/**
 * The sidebar's sections. A tradesperson with one business sees only that business's pages.
 * Everyone else sees the business list (and Phil the Admin page), plus the open business's
 * pages under it. The reseller sees only the list: it can't open a business.
 */
export function navSections(
  me: Pick<MeView, "role" | "tenantIds">,
  openTenantId: string | null,
): NavSection[] {
  const only = me.role === "owner" && me.tenantIds.length === 1 ? me.tenantIds[0] : undefined;
  if (only) return [{ heading: null, items: businessItems(only, false) }];

  const general: NavItem[] = [
    {
      to: "/",
      label: me.role === "owner" ? "Your businesses" : "Businesses",
      icon: "businesses",
      exact: true,
    },
    ...(me.role === "admin" ? [{ to: "/admin", label: "Admin", icon: "admin" as const }] : []),
  ];
  const sections: NavSection[] = [{ heading: null, items: general }];
  if (openTenantId && me.role !== "reseller") {
    sections.push({
      heading: "This business",
      items: businessItems(openTenantId, me.role === "admin"),
    });
  }
  return sections;
}

/** Whether an entry is the page on screen, for its highlight (aria-current="page"). */
export function isCurrent(item: NavItem, pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (item.alsoUnder?.some(under)) return true;
  return item.exact ? path === item.to : under(item.to);
}
