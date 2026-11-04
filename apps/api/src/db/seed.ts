// Fictional seed data for local development and tests: npm run db:seed.
// Safe to run repeatedly: tenants have fixed IDs and existing ones are skipped.
// Phone numbers are from Ofcom's ranges reserved for drama, and emails use example.com.
import { z } from "zod";
import { logger } from "../logger.ts";
import {
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  listTenants,
  type AdminPool,
  type NewTenant,
} from "./cross-tenant.ts";

interface SeedTenant extends NewTenant {
  id: string;
  phoneNumber: string;
  providerSid: string;
}

export const SEED_TENANTS: readonly SeedTenant[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    businessName: "Ant's Plumbing",
    trade: "plumber",
    status: "demo",
    notificationMobile: "+447700900001",
    notificationEmail: "demo@example.com",
    phoneNumber: "+441632960001", // 01632 960001
    providerSid: "PN_SEED_ANTS_PLUMBING",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    businessName: "Test Electrics",
    trade: "electrician",
    status: "onboarding",
    notificationMobile: "+447700900002",
    notificationEmail: "test-electrics@example.com",
    phoneNumber: "+442079460002", // 020 7946 0002
    providerSid: "PN_SEED_TEST_ELECTRICS",
  },
];

/** Creates any seed tenant that doesn't exist yet. Returns the names it created. */
export async function seedDevelopmentData(admin: AdminPool): Promise<string[]> {
  const existing = new Set((await listTenants(admin)).map((tenant) => tenant.id));
  const created: string[] = [];
  for (const { phoneNumber, providerSid, ...tenant } of SEED_TENANTS) {
    if (existing.has(tenant.id)) continue;
    await createTenant(admin, tenant);
    await assignPhoneNumber(admin, tenant.id, phoneNumber, providerSid);
    created.push(tenant.businessName);
  }
  return created;
}

if (import.meta.main) {
  const env = z
    .object({
      NODE_ENV: z.string().optional(),
      ADMIN_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    })
    .safeParse(process.env);

  if (!env.success) {
    logger.error("db:seed needs ADMIN_DATABASE_URL in .env (see .env.example)");
    process.exitCode = 1;
  } else if (env.data.NODE_ENV === "production") {
    // Fictional data must never reach a real database.
    logger.error("db:seed refuses to run with NODE_ENV=production");
    process.exitCode = 1;
  } else {
    const admin = createAdminPool(env.data.ADMIN_DATABASE_URL);
    try {
      const created = await seedDevelopmentData(admin);
      logger.info("Seed complete", { created, skipped: SEED_TENANTS.length - created.length });
    } finally {
      await admin.end();
    }
  }
}
