// The sidebar at its edges: people with no business or many, addresses that nearly match, and
// the highlight never landing on two entries at once.
import { describe, expect, it } from "vitest";
import { isCurrent, navSections, type NavSection } from "./nav.ts";

const labels = (sections: NavSection[]) =>
  sections.map((section) => [section.heading, section.items.map((item) => item.label)]);

/** The entries highlighted on a page. */
function current(sections: NavSection[], pathname: string): string[] {
  return sections.flatMap((section) =>
    section.items.filter((item) => isCurrent(item, pathname)).map((item) => item.label),
  );
}

describe("navSections, for people the usual cases miss", () => {
  it("gives a tradesperson with no business yet only their (empty) list", () => {
    expect(labels(navSections({ role: "owner", tenantIds: [] }, null))).toEqual([
      [null, ["Your businesses"]],
    ]);
  });

  it("keeps a one-business tradesperson on their business's pages, whatever is open", () => {
    // Even on another business's address (which the API refuses), the sidebar doesn't change.
    const me = { role: "owner" as const, tenantIds: ["t1"] };
    expect(navSections(me, "t2")).toEqual(navSections(me, null));
    expect(
      navSections(me, "t2")[0]!.items.every(
        (item) => item.to.startsWith("/tenants/t1/") || item.to === "/tenants/t1",
      ),
    ).toBe(true);
  });

  it("points every business entry at the open business", () => {
    const sections = navSections({ role: "admin", tenantIds: [] }, "abc");
    for (const item of sections[1]!.items) expect(item.to).toMatch(/^\/tenants\/abc(\/|$)/);
  });

  it("gives no two entries the same address or the same words", () => {
    for (const me of [
      { role: "owner" as const, tenantIds: ["t1"] },
      { role: "owner" as const, tenantIds: ["t1", "t2"] },
      { role: "admin" as const, tenantIds: [] },
      { role: "reseller" as const, tenantIds: [] },
    ]) {
      const items = navSections(me, "t1").flatMap((section) => section.items);
      expect(new Set(items.map((item) => item.to)).size, me.role).toBe(items.length);
      expect(new Set(items.map((item) => item.label)).size, me.role).toBe(items.length);
    }
  });
});

describe("isCurrent, with addresses that nearly match", () => {
  const admin = navSections({ role: "admin", tenantIds: [] }, "t1");

  it("highlights exactly one entry on every page the admin can open", () => {
    const pages: [string, string][] = [
      ["/", "Businesses"],
      ["/admin", "Admin"],
      ["/admin/", "Admin"],
      ["/admin/design", "Admin"],
      ["/tenants/t1", "Calls"],
      ["/tenants/t1/calls/c9", "Calls"],
      ["/tenants/t1/profile", "Assistant"],
      ["/tenants/t1/phone", "Phone setup"],
      ["/tenants/t1/settings", "Account"],
      ["/tenants/t1/onboarding", "Onboarding"],
    ];
    for (const [pathname, label] of pages) {
      expect(current(admin, pathname), pathname).toEqual([label]);
    }
  });

  it("doesn't take another business whose id starts the same for this one", () => {
    expect(current(admin, "/tenants/t10")).toEqual([]);
    expect(current(admin, "/tenants/t10/profile")).toEqual([]);
  });

  it("doesn't take a lookalike address for a page", () => {
    expect(current(admin, "/tenants/t1/callsX")).toEqual([]);
    expect(current(admin, "/administrator")).toEqual([]);
    expect(current(admin, "/tenants/t1/phones")).toEqual([]);
  });

  it("ignores any number of slashes on the end", () => {
    expect(current(admin, "/tenants/t1///")).toEqual(["Calls"]);
    expect(current(admin, "/tenants/t1/settings//")).toEqual(["Account"]);
  });
});
