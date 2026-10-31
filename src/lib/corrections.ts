// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Shared helpers for the LexGuard correction UX (spec §26–§33).
 *
 * The escalation dialog, the Stage 4 corrected-field highlights and the audit
 * logger all have to agree on one question: is this field money? Money fields
 * are displayed as USD, typed as dollars, stored on the payload as dollars, and
 * recorded in the audit trail as integer cents. Keeping that decision in one
 * place is what keeps those four representations from drifting.
 */

import { formatUsd, toCents } from "../lexguard/payload-diff";
import type { Escalation, EscalationDiscrepancy } from "../lexguard/pipeline";

/**
 * Field-name substrings that mark a value as money.
 *
 * A name-based heuristic rather than a schema lookup because escalations can
 * name fields the `ParsedRetainerPayload` shape does not carry — `arithmetic`
 * is a constraint, and future asset classes add their own money fields.
 */
const MONEY_HINTS = ["held", "fees", "balance", "amount", "price"] as const;

export function isMoneyField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return MONEY_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Display form for a field value. Money renders as USD; anything else renders
 * as-is. Values that arrived already formatted (`"$4,200.00"`, `"187654"`) pass
 * through untouched rather than being double-formatted.
 */
export function formatFieldValue(fieldName: string, value: number | string | undefined): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "number" && isMoneyField(fieldName)) return formatUsd(toCents(value));
  return String(value);
}

/**
 * The value to pre-fill a correction input with. Money fields get a bare
 * decimal string ("4200.00") so the officer edits a number, not a `$`-prefixed
 * string they then have to clean up.
 */
export function inputValueFor(fieldName: string, value: number | string | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && isMoneyField(fieldName)) return value.toFixed(2);
  return String(value);
}

/**
 * Parse what the officer typed back into the payload's native units — dollars
 * for money (the `ParsedRetainerPayload` convention), the raw string otherwise.
 * Returns null when a money field cannot be read as a number, so callers can
 * refuse the correction instead of writing NaN into a settlement payload.
 */
export function parseFieldInput(fieldName: string, raw: string): number | string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!isMoneyField(fieldName)) return trimmed;
  const parsed = Number(trimmed.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Audit form for a corrected value. Spec §32 records money as integer cents
 * (`officer_corrected_value: 1850000`) even though the payload holds dollars.
 */
export function auditValueFor(fieldName: string, value: number | string | undefined): number | string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && isMoneyField(fieldName)) return Number(toCents(value));
  return value;
}

/**
 * The rule a module enforces, in the officer's language. Shown beside every
 * corrected field and recorded on the HUMAN_CORRECTION event so the audit trail
 * says *why* a value was contested, not just that it was.
 */
export function constraintFor(module: string, field: string): string {
  if (field === "arithmetic") return "earned_fees + unearned_balance must equal total_held";
  switch (module) {
    case "payload-diff":
      return `${field} must match the value observed in the source document`;
    case "anchor-matcher":
      return `${field} must match the trust anchor provided at document load`;
    case "anomaly-watcher":
      return "flagged anomalies must not route to direct settlement";
    case "scope-guard":
      return "AI may read only the authorized field set";
    default:
      return "LexGuard validation constraint";
  }
}

/**
 * How the officer dispositions a single flagged anomaly when the
 * `anomaliesSuppressed` finding escalates (spec §31). `blocking` means the
 * anomaly is real and the escrow must not direct-settle; `acknowledged` means
 * the officer reviewed it and it does not block settlement.
 */
export type AnomalyChoice = "acknowledged" | "blocking";

/** One anomaly plus the officer's disposition of it, carried into the audit log. */
export interface AnomalyDisposition {
  description: string;
  disposition: AnomalyChoice;
}

/**
 * Flatten an escalation into the ordered list the dialog renders — the primary
 * finding first, then every additional discrepancy from the same pass (§31).
 */
export function escalationFindings(escalation: Escalation): EscalationDiscrepancy[] {
  return [
    {
      field: escalation.field,
      module: escalation.module,
      aiValue: escalation.aiValue,
      // Prefer the raw extraction; fall back to the display string for the
      // findings that never carried one.
      observedValue: escalation.documentExtractedValue ?? escalation.observedValue,
      aiAttempt1: escalation.aiAttempt1,
      aiAttempt2: escalation.aiAttempt2,
      aiAttempt3: escalation.aiAttempt3,
      correctionField: escalation.correctionField,
    },
    ...(escalation.additionalDiscrepancies ?? []),
  ];
}
