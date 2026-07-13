/**
 * Document parsing layer.
 *
 * In production this is where the AI model call lives: normalized artifact text
 * + the VDB structured context go in, structured retainer metadata comes out.
 * For a self-contained build we extract deterministically with labeled-field
 * heuristics. Either way the output is an untrusted `ParsedRetainerPayload` that
 * LexGuard validates independently against the artifact — the guarantee the
 * whole system rests on does not depend on how the extraction was produced.
 */

import { ExecutionPath, type ParsedRetainerPayload, type TrustAnchors } from "../lexguard/types";

export interface ExtractionResult {
  payload: ParsedRetainerPayload;
  extractedClientName: string | null;
  extractedBarNumber: string | null;
}

function money(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  const n = parseFloat(match[1].replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function num(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

const RE = {
  total:
    /(?:total\s+(?:retainer\s+)?(?:held|deposit|amount)|retainer\s+held|total\s+held)\s*[:\-]?\s*\$?([\d,]+(?:\.\d{2})?)/i,
  earned: /earned\s+fees?\s*[:\-]?\s*\$?([\d,]+(?:\.\d{2})?)/i,
  unearned: /unearned\s+(?:balance|retainer|amount)?\s*[:\-]?\s*\$?([\d,]+(?:\.\d{2})?)/i,
  disputedHours: /disputed\s+hours?\s*[:\-]?\s*([\d]+(?:\.\d+)?)/i,
  disputedAmount: /disputed\s+(?:amount|fees?|sum)\s*[:\-]?\s*\$?([\d,]+(?:\.\d{2})?)/i,
  clientWallet: /client\s+wallet\s*[:\-]?\s*(0x[0-9a-fA-F]{40})/i,
  firmWallet: /(?:law\s*firm|firm)\s+wallet\s*[:\-]?\s*(0x[0-9a-fA-F]{40})/i,
  clientId: /client\s+id\s*[:\-]?\s*([A-Za-z0-9\-]+)/i,
  signature: /signature[s]?\s*(?:status)?\s*[:\-]?\s*(verified|signed|executed|complete|present|yes)/i,
  barInDoc: /bar\s*(?:no\.?|number|#)\s*[:\-]?\s*(\d{5,8})/i,
  clientNameInDoc: /client\s*(?:full\s*legal\s*)?(?:name)?\s*[:\-]\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)+)/,
  anomalies: /\b(anomal\w*|discrepanc\w*|withheld|irregular\w*|unreconciled)\b/gi,
};

const ZERO = "0x0000000000000000000000000000000000000000";

/** Parse normalized retainer text into an (untrusted) structured payload. */
export function parseRetainerDocument(text: string, anchors: TrustAnchors): ExtractionResult {
  const totalHeld = money(text.match(RE.total)) ?? 0;
  const earnedFees = money(text.match(RE.earned)) ?? 0;
  const unearnedBalance = money(text.match(RE.unearned)) ?? 0;
  const disputedHours = num(text.match(RE.disputedHours)) ?? 0;
  const disputedAmount = money(text.match(RE.disputedAmount)) ?? 0;

  const clientWallet = (text.match(RE.clientWallet)?.[1] as `0x${string}`) ?? (ZERO as `0x${string}`);
  const lawFirmWallet = (text.match(RE.firmWallet)?.[1] as `0x${string}`) ?? (ZERO as `0x${string}`);
  const clientId = text.match(RE.clientId)?.[1] ?? "C-UNKNOWN";
  const signaturesVerified = Boolean(text.match(RE.signature));

  const extractedBarNumber = text.match(RE.barInDoc)?.[1] ?? null;
  const extractedClientName = text.match(RE.clientNameInDoc)?.[1]?.trim() ?? null;

  const anomaliesFlagged: string[] = [];
  const anomalyMatches = text.match(RE.anomalies);
  if (anomalyMatches) {
    anomaliesFlagged.push(`Anomaly language present: ${[...new Set(anomalyMatches.map((m) => m.toLowerCase()))].join(", ")}`);
  }
  if (disputedHours > 0 || disputedAmount > 0) {
    anomaliesFlagged.push("Disputed billing present");
  }

  const recommendedPath =
    disputedHours > 0 || disputedAmount > 0
      ? ExecutionPath.ArbitrationEscrow
      : ExecutionPath.DirectSettlement;

  const payload: ParsedRetainerPayload = {
    clientId,
    lawFirmWallet,
    clientWallet,
    totalHeld,
    earnedFees,
    unearnedBalance,
    disputedHours,
    disputedAmount,
    signaturesVerified,
    recommendedPath,
    anomaliesFlagged,
    anomaliesSuppressed: false,
    barNumber: anchors.attorneyBarNumber,
    clientName: extractedClientName ?? anchors.clientFullLegalName,
    attorneyName: undefined,
  };

  return { payload, extractedClientName, extractedBarNumber };
}

/** The fields AI reads/populates for a retainer release (for ScopeGuard). */
export const AI_ACCESSED_FIELDS = [
  "clientId",
  "lawFirmWallet",
  "clientWallet",
  "totalHeld",
  "earnedFees",
  "unearnedBalance",
  "disputedHours",
  "disputedAmount",
  "signaturesVerified",
  "recommendedPath",
  "anomaliesFlagged",
  "anomaliesSuppressed",
];
