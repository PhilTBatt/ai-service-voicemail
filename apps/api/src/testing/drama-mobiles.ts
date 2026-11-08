// Mobiles for tests that look a business up by its mobile (CLAUDE.md rule 3: fictional numbers
// only). Ofcom reserves just 1,000 mobiles for drama, 07700 900000 to 900999
// (https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama), and a
// lookup by mobile needs the mobile to be one business's alone: a shared one reads as unknown.
// So each test file that needs that takes a band of the range that no other test uses, and
// a mobile is freed from any business an earlier test in the same file gave it to. (Test files
// run in parallel; the tests inside one file run one after another.)
import type { AdminPool } from "../db/cross-tenant.ts";

/** Each file's band, clear of every fixed test mobile (000-123, 321-323, 456, 555, 6xx, 701, 8xx, 9xx). */
export const MOBILE_BANDS = {
  "db/tenant-commands.test.ts": [200, 299],
  "routes/twilio.test.ts": [710, 799],
} as const;

/** A drama-range mobile from the band, held by no business until the caller gives it to one. */
export async function bandMobile(
  admin: AdminPool,
  [from, to]: readonly [number, number],
): Promise<string> {
  const ending = from + Math.floor(Math.random() * (to - from + 1));
  const mobile = `+447700900${String(ending).padStart(3, "0")}`;
  await admin.query(
    "UPDATE tenants SET notification_mobile = NULL WHERE notification_mobile = $1",
    [mobile],
  );
  return mobile;
}
