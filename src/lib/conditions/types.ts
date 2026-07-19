/**
 * Condition type system — the vocabulary of Stage 7 (spec §6).
 *
 * Every release condition LexEscrow tracks, across every asset class, reduces
 * to one of seven types and one of five statuses. The Escrow Monitor renders
 * that uniform shape; `builder.ts` is what projects the heterogeneous session
 * state (AnchorReceipt items, DocuSign envelopes, CannaVerify results, bar
 * verification) onto it.
 *
 * The type-specific metadata lives in optional fields rather than a
 * discriminated union on purpose: conditions round-trip through SQLite as a
 * single table with a `metadata_json` blob, and a union would force a parse-time
 * narrowing step on every read for no gain the UI can use.
 */

export type ConditionType =
  | "document" // specific document must be registered
  | "time" // release after defined date
  | "esign" // all parties must sign via DocuSign
  | "cannaverify" // cannabis regulatory verification
  | "bar_verify" // attorney bar verification
  | "event" // external event via CRE adapter
  | "manual"; // human confirms manually

/**
 * Condition lifecycle.
 *
 * `waived` is deliberately distinct from `met`: a waived condition was never
 * satisfied, a human decided to proceed without it. Collapsing the two would
 * erase exactly the fact an auditor is looking for, so the two are counted
 * separately in {@link ConditionSummary} and rendered differently by the monitor.
 */
export type ConditionStatus = "pending" | "in_progress" | "met" | "failed" | "waived";

export interface Condition {
  id: string;
  type: ConditionType;
  label: string;
  description: string;
  status: ConditionStatus;
  assetClass: string;
  // Type-specific metadata
  documentHash?: string; // for 'document' type
  documentLabel?: string;
  releaseDate?: string; // for 'time' type (ISO date)
  envelopeId?: string; // for 'esign' type
  signers?: string[]; // names of required signers
  signerStatuses?: Record<string, string>; // name → esign status
  cannaVerifyResult?: string; // 'PASS' | 'FAIL' | 'ERROR'
  barNumber?: string; // for 'bar_verify' type
  barVerified?: boolean;
  eventDescription?: string; // for 'event' type
  creAdapterUrl?: string;
  metAt?: string; // ISO timestamp when condition met
  failedAt?: string;
  failureReason?: string;
  onChainTx?: string; // CRE verification tx
}

/**
 * Checklist tally driving the settlement gate.
 *
 * `met + pending + failed` does **not** necessarily equal `total` — waived
 * conditions are in none of the three buckets. Derive the waived count as the
 * remainder rather than assuming the buckets partition the set.
 */
export interface ConditionSummary {
  total: number;
  met: number;
  pending: number;
  failed: number;
  allMet: boolean;
}
