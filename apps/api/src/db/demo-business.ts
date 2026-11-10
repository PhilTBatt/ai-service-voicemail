// The demo business ("Ant's Plumbing", the seed's first tenant) on a real database: what
// npm run db:seed and npm run demo:profile do locally, with the contact details and the
// number supplied rather than fictional, so the same fixed tenant ID carries the demo line in
// production (live-configure-number and demo:profile both find it by that ID). Safe to run
// again: an existing business is left as it is, its profile saved afresh.
import type { AgentProfileInput } from "@callmate/shared";
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { saveAgentProfile } from "./agent-profiles.ts";
import {
  activeNumberFor,
  assignPhoneNumber,
  auditScriptAction,
  createTenant,
  tenantExists,
  type AdminPool,
} from "./cross-tenant.ts";
import { SEED_TENANTS } from "./seed.ts";

/** The demo agent's profile: the Leeds plumber Ant demonstrates with. Fictional, by design. */
export const DEMO_PROFILE: AgentProfileInput = {
  trade: "plumber",
  services: ["boiler repairs and servicing", "burst pipes and leaks", "bathroom fitting"],
  serviceAreas: ["Leeds", "Bradford", "Wakefield"],
  openingHours: {
    mon: { open: "08:00", close: "18:00" },
    tue: { open: "08:00", close: "18:00" },
    wed: { open: "08:00", close: "18:00" },
    thu: { open: "08:00", close: "18:00" },
    fri: { open: "08:00", close: "17:00" },
    sat: { open: "09:00", close: "13:00" },
    sun: null,
  },
  holidayMode: false,
  holidayUntil: null,
  faqs: [
    {
      question: "Do you fit bathrooms?",
      answer:
        "Yes, full bathroom fitting is one of the services. Ant will talk it through when he calls back.",
    },
  ],
  emergencyPolicy: { takesEmergencyCalls: true },
};

export interface DemoBusinessInput {
  /** Where the demo line's texts go: a real mobile, E.164. */
  mobile: string;
  /** Where its emails go. */
  email: string;
  /** The line itself, as bought in Twilio's console, and its SID there. */
  number: string;
  providerSid: string;
}

export interface DemoBusinessOutcome {
  tenantId: string;
  created: boolean;
  /** Whether the number was recorded now (false: it was already the active one). */
  numberRecorded: boolean;
  profileVersion: number;
}

export async function createDemoBusiness(
  { admin, pool, boss }: { admin: AdminPool; pool: pg.Pool; boss: PgBoss },
  input: DemoBusinessInput,
): Promise<DemoBusinessOutcome> {
  const demo = SEED_TENANTS[0]!;
  const created = !(await tenantExists(admin, demo.id));
  if (created) {
    await createTenant(admin, {
      id: demo.id,
      businessName: demo.businessName,
      trade: demo.trade,
      ...(demo.contactName !== undefined && { contactName: demo.contactName }),
      ...(demo.status !== undefined && { status: demo.status }),
      notificationMobile: input.mobile,
      notificationEmail: input.email,
    });
  }
  const active = await activeNumberFor(admin, demo.id);
  const numberRecorded = active?.number !== input.number;
  if (numberRecorded) {
    if (active) {
      throw new Error(
        `The demo business already has a different active number; use live-configure-number --adopt to change it`,
      );
    }
    await assignPhoneNumber(admin, demo.id, input.number, input.providerSid);
  }
  const profileVersion = await saveAgentProfile(pool, boss, demo.id, DEMO_PROFILE);
  await auditScriptAction(admin, {
    tenantId: demo.id,
    action: "demo_business_set_up",
    details: { created, numberRecorded, profileVersion },
  });
  return { tenantId: demo.id, created, numberRecorded, profileVersion };
}
