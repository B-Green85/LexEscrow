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

export interface Escalation {
  module: string;
  field: string;
  fieldLabel: string;
  aiValue: string;
  observedValue: string;
  recommendation: string;
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
    if (corrected == null) break; // correction transport failed → escalate
    if (changed) (payload as unknown as Record<string, number>)[target.field] = corrected;
    // otherwise retry up to MAX_NUDGES
  }

  // Final evaluation — the first unresolved discrepancy becomes the escalation.
  const finalDiffs = diffNumericsWithVDB(payload, vdb);
  const remainingNumeric = finalDiffs.find(
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

  let escalation: Escalation | null = null;
  if (remainingNumeric) {
    escalation = {
      module: "payload-diff",
      field: remainingNumeric.field,
      fieldLabel: "Unearned Balance",
      aiValue: formatDollars(Number(remainingNumeric.aiValue)),
      observedValue: formatDollars(Number(remainingNumeric.observedValue)),
      recommendation: "Review the billing records section of the retainer agreement before proceeding.",
    };
  } else if (arithmeticBroken) {
    escalation = {
      module: "payload-diff",
      field: "arithmetic",
      fieldLabel: "Retainer Arithmetic",
      aiValue: `${formatDollars(payload.earnedFees)} + ${formatDollars(payload.unearnedBalance)} = ${formatDollars(
        payload.earnedFees + payload.unearnedBalance,
      )}`,
      observedValue: `${formatDollars(payload.totalHeld)} total held`,
      recommendation:
        "Earned fees plus unearned balance do not equal the total retainer held. Review the billing reconciliation section before proceeding.",
    };
  } else if (!barOk) {
    escalation = {
      module: "anchor-matcher",
      field: "barNumber",
      fieldLabel: "Attorney Bar Number",
      aiValue: payload.extractedBarNumber ?? "—",
      observedValue: anchors.attorneyBarNumber,
      recommendation: "The bar number found in the document does not match the verified attorney identity.",
    };
  } else if (!clientNameOk) {
    escalation = {
      module: "anchor-matcher",
      field: "clientName",
      fieldLabel: "Client Name",
      aiValue: payload.clientName ?? "—",
      observedValue: anchors.clientFullLegalName,
      recommendation: "The client name in the document does not match the name entered at document load.",
    };
  } else if (suppressed) {
    escalation = {
      module: "anomaly-watcher",
      field: "anomaliesSuppressed",
      fieldLabel: "Flagged Anomalies",
      aiValue: "Routed to direct settlement",
      observedValue: `${payload.anomaliesFlagged.length} anomaly(ies) flagged`,
      recommendation:
        "Anomalies were flagged during parsing but the workflow would proceed to direct settlement. Route to arbitration or resolve the anomalies.",
    };
  } else if (scopeViolations.length > 0) {
    escalation = {
      module: "scope-guard",
      field: scopeViolations[0],
      fieldLabel: "Field Access",
      aiValue: scopeViolations.join(", "),
      observedValue: "authorized fields only",
      recommendation: "AI accessed one or more fields outside the authorized set for a retainer release.",
    };
  }

  return { payload, corrections, escalation };
}
