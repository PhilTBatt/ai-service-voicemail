// Who a logged-in person is to us (BUILD_PLAN Step 10): their role and tenants. Reads go
// through the owner-run account_for_subject function, because the app role can't see users.
import type pg from "pg";

export const ROLES = ["owner", "admin", "reseller"] as const;
export type Role = (typeof ROLES)[number];

export interface Account {
  userId: string;
  email: string;
  role: Role;
  /** The tenants this person belongs to. Admins and resellers usually have none. */
  tenantIds: string[];
}

interface AccountRow {
  user_id: string;
  email: string;
  role: Role;
  tenant_id: string | null;
}

/** The account behind a login provider's subject ID, or null when nobody has that subject. */
export async function findAccountBySubject(
  pool: pg.Pool,
  subject: string,
): Promise<Account | null> {
  const { rows } = await pool.query<AccountRow>("SELECT * FROM account_for_subject($1)", [subject]);
  const first = rows[0];
  if (!first) return null;
  return {
    userId: first.user_id,
    email: first.email,
    role: first.role,
    tenantIds: rows.flatMap((row) => (row.tenant_id === null ? [] : [row.tenant_id])),
  };
}
