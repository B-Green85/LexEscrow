// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * LexGuard co-validation pipeline (async).
 *
 * Runs the VDB cross-reference and all five modules against an AI extraction,
 * nudging numeric-field discrepancies back to the same AI provider up to three
 * times before escalating. Extracted from the store so it can be exercised with
 * an injected provider in tests.
 */

import { diffNumericsWithVDB, formatUsd, toCents, validateArithmetic } from "./payload-diff";
import { type VDBStore } from "./vdb";
import { matchBarNumber, matchClientName } from "./anchor-matcher";
import { detectAnomalySuppression } from "./anomaly-watcher";
import { detectScopeViolation } from "./scope-guard";
import { type ParsedRetainerPayload, type TrustAnchors } from "./types";
import { AI_ACCESSED_FIELDS } from "../lib/aiParse";
import { type AIParserProvider } from "../lib/ai/providers";

export interface LexGuardCorrection {
  module: string;
  field: string;
  aiValue: string | number;
  observedValue: string | number;
  nudgeCount: number;
  resolved: boolean;
  timestamp: string;
}

/**
 * One unresolved discrepancy beyond the primary (spec §31, multi-field cascade).
 * The escalation dialog renders the primary and these together, so the officer
 * works through every affected field before processing can resume.
 */
export interface EscalationDiscrepancy {
  field: string;
  module: string;
  aiValue: number | string;
  observedValue: number | string;
  /** What AI returned on each nudge — undefined if that attempt never landed. */
  aiAttempt1?: number | string;
  aiAttempt2?: number | string;
  aiAttempt3?: number | string;
  /**
   * Payload field a human correction writes to. Usually identical to `field`;
   * `arithmetic` is a constraint rather than a field, so it targets `totalHeld`.
   * Undefined means the finding is not a value the officer can restate (a scope
   * violation, a suppressed anomaly) — it is attested to, not overwritten.
   */
  correctionField?: string;
}

export interface Escalation {
  module: string;
  field: string;
  fieldLabel: string;
  aiValue: string;
  observedValue: string;
  recommendation: string;

  // ── Session 4 additions (spec §29) ────────────────────────────────────────
  // Raw, unformatted values. The escalation dialog formats money for display
  // and pre-fills its input from `documentExtractedValue`.
  /** What AI returned on nudge 1 — undefined if the attempt never landed. */
  aiAttempt1?: number | string;
  aiAttempt2?: number | string;
  aiAttempt3?: number | string;
  /** LexGuard's independent extraction — the ground truth the officer compares against. */
  documentExtractedValue?: number | string;
  /** Payload field a human correction writes to. See EscalationDiscrepancy. */
  correctionField?: string;
  /** Every other unresolved discrepancy found in the same pass. */
  additionalDiscrepancies?: EscalationDiscrepancy[];
}

export interface PipelineInput {
  payload: ParsedRetainerPayload;
  vdb: VDBStore;
  anchors: TrustAnchors;
  chainlinkVerifiedBar: string;
  provider: AIParserProvider;
}

export interface PipelineResult {
  payload: ParsedRetainerPayload;
  corrections: LexGuardCorrection[];
  escalation: Escalation | null;
}

const MAX_NUDGES = 3;
const formatDollars = (n: number): string => formatUsd(toCents(n));

export async function runLexGuardPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { vdb, anchors, chainlinkVerifiedBar, provider } = input;
  const corrections: LexGuardCorrection[] = [];
  const payload = { ...input.payload };
  const now = () => new Date().toISOString();

  // Per-field record of what AI actually returned on each nudge. The escalation
  // dialog shows all three so the officer can tell a consistently-wrong model
  // from an oscillating one (spec §29).
  const attempts = new Map<string, Array<number | string>>();
  const recordAttempt = (field: string, value: number | string) => {
    const list = attempts.get(field) ?? [];
    list.push(value);
    attempts.set(field, list);
  };
  const attemptsFor = (field: string) => {
    const [aiAttempt1, aiAttempt2, aiAttempt3] = attempts.get(field) ?? [];
    return { aiAttempt1, aiAttempt2, aiAttempt3 };
  };

  // Nudge loop — a numeric field diff with a VDB sentinel is nudged back to AI.
  let nudges = 0;
  while (nudges < MAX_NUDGES) {
    const diffs = diffNumericsWithVDB(payload, vdb);
    const target = diffs.find((d) => d.field !== "arithmetic" && typeof d.observedValue === "number");
    if (!target) break; // resolved

    const current = Number(target.aiValue);
    const sentinel = Number(target.observedValue);
    const corrected = await provider.correct(target.field, current, sentinel);
    nudges++;

    const changed = corrected != null && toCents(corrected) !== toCents(current);
    corrections.push({
      module: "payload-diff",
      field: target.field,
      aiValue: current,
      observedValue: corrected ?? sentinel,
      nudgeCount: nudges,
      resolved: changed,
      timestamp: now(),
    });
    if (corrected != null) recordAttempt(target.field, corrected);
    if (corrected == null) break; // correction transport failed → escalate
    if (changed) (payload as unknown as Record<string, number>)[target.field] = corrected;
    // otherwise retry up to MAX_NUDGES
  }

  // Final evaluation — every unresolved discrepancy is collected. The first (in
  // module priority order) becomes the primary escalation; the rest ride along
  // as `additionalDiscrepancies` so the officer resolves them in one dialog
  // rather than one escalation per round trip (spec §31).
  const finalDiffs = diffNumericsWithVDB(payload, vdb);
  const remainingNumerics = finalDiffs.filter(
    (d) => d.field !== "arithmetic" && typeof d.observedValue === "number",
  );
  const arithmeticBroken = !validateArithmetic(payload);
  const barOk = matchBarNumber(payload.extractedBarNumber ?? null, anchors.attorneyBarNumber, chainlinkVerifiedBar);
  const clientNameOk = payload.clientName
    ? matchClientName(payload.clientName, anchors.clientFullLegalName)
    : true;
  const suppressed = detectAnomalySuppression(
    payload.anomaliesFlagged,
    payload.anomaliesSuppressed,
    payload.recommendedPath,
  );
  const scopeViolations = detectScopeViolation(AI_ACCESSED_FIELDS);

  // Candidates in module priority order — index 0 becomes the primary. Each
  // carries both the display strings the escalation screen has always shown and
  // the raw values the correction dialog needs to pre-fill and write back.
  const candidates: Escalation[] = [];

  for (const numeric of remainingNumerics) {
    candidates.push({
      module: "payload-diff",
      field: numeric.field,
      fieldLabel: "Unearned Balance",
      aiValue: formatDollars(Number(numeric.aiValue)),
      observedValue: formatDollars(Number(numeric.observedValue)),
      recommendation: "Review the billing records section of the retainer agreement before proceeding.",
      documentExtractedValue: numeric.observedValue,
      correctionField: numeric.field,
      ...attemptsFor(numeric.field),
    });
  }

  if (arithmeticBroken) {
    candidates.push({
      module: "payload-diff",
      field: "arithmetic",
      fieldLabel: "Retainer Arithmetic",
      aiValue: `${formatDollars(payload.earnedFees)} + ${formatDollars(payload.unearnedBalance)} = ${formatDollars(
        payload.earnedFees + payload.unearnedBalance,
      )}`,
      observedValue: `${formatDollars(payload.totalHeld)} total held`,
      recommendation:
        "Earned fees plus unearned balance do not equal the total retainer held. Review the billing reconciliation section before proceeding.",
      // The constraint spans three fields; the total is the one the officer
      // restates, matching the spec §32 `total_held_cents` audit example.
      documentExtractedValue: payload.totalHeld,
      correctionField: "totalHeld",
      ...attemptsFor("arithmetic"),
    });
  }

  if (!barOk) {
    candidates.push({
      module: "anchor-matcher",
      field: "barNumber",
      fieldLabel: "Attorney Bar Number",
      aiValue: payload.extractedBarNumber ?? "—",
      observedValue: anchors.attorneyBarNumber,
      recommendation: "The bar number found in the document does not match the verified attorney identity.",
      documentExtractedValue: anchors.attorneyBarNumber,
      correctionField: "extractedBarNumber",
      ...attemptsFor("barNumber"),
    });
  }

  if (!clientNameOk) {
    candidates.push({
      module: "anchor-matcher",
      field: "clientName",
      fieldLabel: "Client Name",
      aiValue: payload.clientName ?? "—",
      observedValue: anchors.clientFullLegalName,
      recommendation: "The client name in the document does not match the name entered at document load.",
      documentExtractedValue: anchors.clientFullLegalName,
      correctionField: "clientName",
      ...attemptsFor("clientName"),
    });
  }

  if (suppressed) {
    candidates.push({
      module: "anomaly-watcher",
      field: "anomaliesSuppressed",
      fieldLabel: "Flagged Anomalies",
      aiValue: "Routed to direct settlement",
      observedValue: `${payload.anomaliesFlagged.length} anomaly(ies) flagged`,
      recommendation:
        "Anomalies were flagged during parsing but the workflow would proceed to direct settlement. Route to arbitration or resolve the anomalies.",
      // Not a value the officer restates — it is a routing decision to attest to.
      documentExtractedValue: `${payload.anomaliesFlagged.length} anomaly(ies) flagged`,
    });
  }

  if (scopeViolations.length > 0) {
    candidates.push({
      module: "scope-guard",
      field: scopeViolations[0],
      fieldLabel: "Field Access",
      aiValue: scopeViolations.join(", "),
      observedValue: "authorized fields only",
      recommendation: "AI accessed one or more fields outside the authorized set for a retainer release.",
      documentExtractedValue: "authorized fields only",
    });
  }

  const [primary, ...rest] = candidates;
  const escalation: Escalation | null = primary
    ? {
        ...primary,
        additionalDiscrepancies: rest.map((c) => ({
          field: c.field,
          module: c.module,
          // Raw where we have it, display string otherwise — the dialog renders
          // both through the same money-aware formatter.
          aiValue: c.aiValue,
          observedValue: c.documentExtractedValue ?? c.observedValue,
          aiAttempt1: c.aiAttempt1,
          aiAttempt2: c.aiAttempt2,
          aiAttempt3: c.aiAttempt3,
          correctionField: c.correctionField,
        })),
      }
    : null;

  return { payload, corrections, escalation };
}
