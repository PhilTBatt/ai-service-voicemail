import { describe, expect, it } from "vitest";
import { isCurrent, navSections, type NavSection } from "./nav.ts";

const labels = (sections: NavSection[]) =>
  sections.map((section) => [section.heading, section.items.map((item) => item.label)]);

describe("navSections", () => {
  it("gives a tradesperson with one business only that business's pages, wherever they are", () => {
    const me = { role: "owner" as const, tenantIds: ["t1"] };
    expect(labels(navSections(me, null))).toEqual([
      [null, ["Calls", "Assistant", "Phone setup", "Account"]],
    ]);
    expect(navSections(me, "t1")[0]!.items[0]!.to).toBe("/tenants/t1");
  });

  it("gives the admin the list, the Admin page, and the open business with its Onboarding", () => {
    const me = { role: "admin" as const, tenantIds: [] };
    expect(labels(navSections(me, null))).toEqual([[null, ["Businesses", "Admin"]]]);
    expect(labels(navSections(me, "t9"))).toEqual([
      [null, ["Businesses", "Admin"]],
      ["This business", ["Calls", "Assistant", "Phone setup", "Account", "Onboarding"]],
    ]);
  });

  it("gives a tradesperson with two businesses their list and the open one", () => {
    const me = { role: "owner" as const, tenantIds: ["t1", "t2"] };
    expect(labels(navSections(me, "t2"))).toEqual([
      [null, ["Your businesses"]],
      ["This business", ["Calls", "Assistant", "Phone setup", "Account"]],
    ]);
  });

  it("never offers the reseller a business's pages, which the API refuses it", () => {
    const me = { role: "reseller" as const, tenantIds: [] };
    expect(labels(navSections(me, "t1"))).toEqual([[null, ["Businesses"]]]);
  });
});

describe("isCurrent", () => {
  const [calls, assistant] = navSections({ role: "owner", tenantIds: ["t1"] }, null)[0]!.items;

  it("counts a call as part of Calls, and the other pages as theirs only", () => {
    expect(isCurrent(calls!, "/tenants/t1")).toBe(true);
    expect(isCurrent(calls!, "/tenants/t1/")).toBe(true);
    expect(isCurrent(calls!, "/tenants/t1/calls/c1")).toBe(true);
    expect(isCurrent(calls!, "/tenants/t1/profile")).toBe(false);
    expect(isCurrent(assistant!, "/tenants/t1/profile")).toBe(true);
    expect(isCurrent(assistant!, "/tenants/t1/profileX")).toBe(false);
  });

  it("keeps the business list to its own page, and Admin to everything under it", () => {
    const [list, admin] = navSections({ role: "admin", tenantIds: [] }, null)[0]!.items;
    expect(isCurrent(list!, "/")).toBe(true);
    expect(isCurrent(list!, "/admin")).toBe(false);
    expect(isCurrent(admin!, "/admin/billing")).toBe(true);
  });
});
