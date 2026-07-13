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

export enum ExecutionPath {
  DirectSettlement = "DirectSettlement",
  ArbitrationEscrow = "ArbitrationEscrow",
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
