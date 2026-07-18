/**
 * Shared LexGuard types.
 *
 * Money convention: `ParsedRetainerPayload` carries dollar amounts as `number`
 * (the form AI extracts, and the field names ScopeGuard authorizes). LexGuard
 * converts every dollar value to **integer cents (`bigint`)** at the validation
 * boundary via `toCents` — no floating-point arithmetic is ever performed on
 * financial values (spec edge case #3). `PayloadCents` is the canonical
 * integer-cents form used for persistence and CRE execution.
 */

import { z } from "zod";

export enum ExecutionPath {
  DirectSettlement = "DirectSettlement",
  ArbitrationEscrow = "ArbitrationEscrow",
  StagedRelease = "StagedRelease",
}

/**
 * AI's structured extraction from the retainer artifacts. Dollar-denominated.
 * The financial/decision field names here are exactly the set ScopeGuard
 * authorizes AI to read and populate.
 */
export interface ParsedRetainerPayload {
  // ── AI-authorized fields (see scope-guard AUTHORIZED_FIELDS) ──────────────
  clientId: string;
  lawFirmWallet: string;
  clientWallet: string;
  totalHeld: number; // dollars
  earnedFees: number; // dollars
  unearnedBalance: number; // dollars
  disputedHours: number;
  disputedAmount: number; // dollars
  signaturesVerified: boolean;
  recommendedPath: ExecutionPath;
  anomaliesFlagged: string[];
  anomaliesSuppressed: boolean;

  // ── Verification / trust-anchor context (populated by the app, not AI) ────
  barNumber: string;
  clientName?: string; // proper noun extracted from the document
  extractedBarNumber?: string | null; // bar number as written in the document (AnchorMatcher)
  attorneyName?: string; // identity returned by bar verification
  lawFirmBillingApi?: string;
  releaseDocument?: string;
}

/** Canonical integer-cents form — persistence + CRE. */
export interface PayloadCents {
  totalHeldCents: bigint;
  earnedFeesCents: bigint;
  unearnedBalanceCents: bigint;
  disputedAmountCents: bigint;
  disputedHours: number;
}

/** Field → value observed independently in the raw artifact text (dollars). */
export type NumericObservations = Record<string, number>;

/** User-provided trust anchors collected on the Document Load screen. */
export interface TrustAnchors {
  attorneyBarNumber: string;
  state: string;
  clientFullLegalName: string;
  clientEmail: string;
  clientPhone?: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const finiteNumber = z.coerce.number().refine((n) => Number.isFinite(n), {
  message: "must be a finite number",
});

/**
 * Zod schema for the AI's raw extraction. Monetary fields are **integer cents**
 * (as the system prompt instructs the model); the provider converts them to the
 * dollar-denominated `ParsedRetainerPayload` after validation. Required fields
 * (the money values and `recommendedPath`) failing validation trigger the
 * single retry, then a plain-English error.
 */
export const AiExtractionSchema = z.object({
  clientId: z.string().default("C-UNKNOWN"),
  lawFirmWallet: z.string().default(ZERO_ADDRESS),
  clientWallet: z.string().default(ZERO_ADDRESS),
  totalHeld: finiteNumber, // integer cents
  earnedFees: finiteNumber, // integer cents
  unearnedBalance: finiteNumber, // integer cents
  disputedHours: finiteNumber.default(0),
  disputedAmount: finiteNumber.default(0), // integer cents
  signaturesVerified: z.boolean().default(false),
  recommendedPath: z.enum(["DirectSettlement", "ArbitrationEscrow", "StagedRelease"]),
  anomaliesFlagged: z.array(z.string()).default([]),
  anomaliesSuppressed: z.boolean().default(false),
});

export type AiExtraction = z.infer<typeof AiExtractionSchema>;
