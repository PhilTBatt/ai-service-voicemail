import type { TenantProfile } from "../core/profile.ts";
import { SEED_TENANTS } from "../db/seed.ts";

// Fictional data only: the seed's demo tenant, with a made-up area and FAQ.

export function sampleProfile(overrides: Partial<TenantProfile> = {}): TenantProfile {
  return {
    tenantId: SEED_TENANTS[0]!.id,
    profileVersion: 1,
    businessName: "Ant's Plumbing",
    tradespersonName: "Ant",
    trade: "plumber",
    serviceRegion: "GB",
    isDemo: true,
    services: ["boiler repairs", "burst pipes", "bathroom fitting"],
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
    ...overrides,
  };
}
