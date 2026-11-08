// Signing up (BUILD_PLAN Step 11): the legal documents a tradesperson accepts, the mobile
// networks we know divert codes for (Appendix C), and the signup form's rules, shared so the
// page checks the form exactly as the API does.
import { z } from "zod";
import { ukMobileSchema } from "./settings.ts";
import { TRADES } from "./trades.ts";

export const LEGAL_DOCUMENT_TYPES = ["terms", "dpa", "privacy_notice"] as const;
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export interface LegalDocument {
  title: string;
  /** Stored with each acceptance (terms_acceptances.document_version). */
  version: string;
  /** False until Phil uploads the solicitor-approved text (BUILD_PLAN Step 11 🛑). */
  approved: boolean;
  /** What the signup page shows. */
  summary: string;
  /** Where the full text is, once there is one: the signup and documents pages link to it. */
  url?: string;
}

const PLACEHOLDER =
  "Placeholder: a solicitor is writing the real document. Until it's in place, only test businesses can go live.";

/**
 * The documents a business accepts at signup. While any is a placeholder, only a business
 * signed up from a test link may go live (core/onboarding.ts). When the solicitor's documents
 * arrive, give each a new version as well as setting `approved`: a placeholder version never
 * counts as approved (index.test.ts and db/onboarding.ts check), so nobody who accepted a
 * placeholder goes live without accepting the real document. Changing a version here makes
 * an open signup page ask the person to reload, so nobody accepts a version they didn't see.
 */
export const LEGAL_DOCUMENTS: Record<LegalDocumentType, LegalDocument> = {
  terms: {
    title: "Terms of service",
    version: "placeholder-2026-11-08",
    approved: false,
    summary: PLACEHOLDER,
  },
  dpa: {
    title: "Data processing agreement",
    version: "placeholder-2026-11-08",
    approved: false,
    summary: PLACEHOLDER,
  },
  privacy_notice: {
    title: "Privacy notice",
    version: "placeholder-2026-11-08",
    approved: false,
    summary: PLACEHOLDER,
  },
};

/** A business's latest accepted version of each document, as the API reads it. */
export type AcceptedVersions = Partial<Record<LegalDocumentType, string>>;

/**
 * The documents whose current version a business hasn't accepted: never accepted, or changed
 * since (a new version above). The dashboard asks the owner to accept them; the go-live rule
 * already refuses a business without them (db/onboarding.ts).
 */
export function documentsToAccept(accepted: AcceptedVersions): LegalDocumentType[] {
  return LEGAL_DOCUMENT_TYPES.filter((type) => accepted[type] !== LEGAL_DOCUMENTS[type].version);
}

const versionSeen = z.string().min(1).max(100);

/**
 * POST /api/tenants/:id/documents/accept: the version of each document the owner read and
 * accepted. The API checks each is still the current one, so nobody accepts a version they
 * didn't see.
 */
export const acceptDocumentsSchema = z.object({
  versions: z
    .strictObject({
      terms: versionSeen.optional(),
      dpa: versionSeen.optional(),
      privacy_notice: versionSeen.optional(),
    })
    .refine((versions) => Object.values(versions).some(Boolean), "Accept at least one document"),
});
export type AcceptDocumentsInput = z.infer<typeof acceptDocumentsSchema>;

/** The UK mobile networks Appendix C has notes for, and "other". */
export const MOBILE_NETWORKS = {
  ee: "EE",
  o2: "O2",
  vodafone: "Vodafone",
  three: "Three",
  giffgaff: "giffgaff",
  tesco_mobile: "Tesco Mobile",
  sky_mobile: "Sky Mobile",
  voxi: "VOXI",
  lebara: "Lebara",
  lyca: "Lyca Mobile",
  bt_mobile: "BT Mobile",
  id_mobile: "iD Mobile",
  smarty: "SMARTY",
  other: "Another network",
} as const;

export type MobileNetwork = keyof typeof MOBILE_NETWORKS;
export const MOBILE_NETWORK_KEYS = Object.keys(MOBILE_NETWORKS) as [
  MobileNetwork,
  ...MobileNetwork[],
];

export const signupInputSchema = z.object({
  /** The code from the signup link. */
  code: z.string().min(16, "this signup link isn't complete").max(100),
  businessName: z.string().trim().min(1, "can't be empty").max(100, "keep it under 100 characters"),
  trade: z.enum(TRADES),
  /** The tradesperson's name, as callers will hear it ("Sam will call you back"). */
  contactName: z.string().trim().min(1, "can't be empty").max(60, "keep it under 60 characters"),
  mobile: ukMobileSchema,
  /** Where call emails go. Null: the address they signed in with. */
  email: z.email("must be an email address").nullable(),
  mobileNetwork: z.enum(MOBILE_NETWORK_KEYS),
  usesNetworkVoicemail: z.boolean(),
  /** The version of each document the person saw and ticked. */
  accepted: z.object({
    terms: z.string().min(1, "must be accepted"),
    dpa: z.string().min(1, "must be accepted"),
    privacy_notice: z.string().min(1, "must be accepted"),
  }),
});
export type SignupInput = z.infer<typeof signupInputSchema>;

/** GET /api/signup/:code */
export interface SignupLinkView {
  forTest: boolean;
  expiresAt: string;
  documents: Record<LegalDocumentType, LegalDocument>;
}

/** POST /api/signup-links */
export interface CreatedSignupLinkView {
  /** Shown once: only a hash is stored. */
  code: string;
  expiresAt: string;
  forTest: boolean;
}

/** POST /api/signup */
export interface SignupResultView {
  tenantId: string;
}
