// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * vdb — session-scoped VDB store.
 *
 * A lightweight, session-scoped index primed once from the (already
 * normalized) artifact text at load time. It gives AI a structured working
 * context and LexGuard a fast lookup layer, eliminating redundant raw-artifact
 * reads. It is NOT a validation authority: the artifact is ground truth, and
 * LexGuard validates AI output against artifact-derived values, not VDB values.
 *
 * The store is bound to the artifact SHA-256 hash at prime time. If the
 * artifact changes (hash mismatch), the store is invalidated and re-primed.
 */

import { isDurationNumeric } from "./anchor-matcher";

export interface VDBEntry {
  type: "numeric" | "proper_noun" | "identifier" | "flag";
  value: string | number;
  field: string; // inferred field context
  section: string; // document section where found
  position: number; // character offset in source
  confidence: number; // extraction confidence 0.0–1.0
}

export interface VDBStore {
  sessionId: string;
  artifactHash: string; // ties the VDB to the hashed artifact
  entries: VDBEntry[];
  primedAt: string;
}

// ── Inference helpers ───────────────────────────────────────────────────────

const FIELD_KEYWORDS: ReadonlyArray<[RegExp, string]> = [
  // Order matters: check "unearned" before "earned".
  [/unearned/i, "unearnedBalance"],
  [/earned/i, "earnedFees"],
  [/total (?:retainer|held|amount|deposit)|retainer (?:held|balance|deposit|amount)|total/i, "totalHeld"],
  [/disput\w* (?:amount|fees|sum|\$)/i, "disputedAmount"],
  [/disput\w* hours|hours? (?:in )?disput/i, "disputedHours"],
  [/bar (?:no\.?|number|#)/i, "barNumber"],
  [/client (?:id|no\.?|number|reference)/i, "clientId"],
];

/** Infer the field a value belongs to from the ~64 chars preceding it. */
export function inferFieldContext(text: string, index: number): string {
  const window = text.slice(Math.max(0, index - 64), index);
  for (const [pattern, field] of FIELD_KEYWORDS) {
    if (pattern.test(window)) return field;
  }
  return "unknown";
}

const HEADING = /^(?:[A-Z0-9][A-Z0-9 .,'()/&-]{2,}|(?:section|article|exhibit|schedule)\b.*|.+:)$/i;

/** Infer the nearest preceding heading-like line as the section label. */
export function inferSection(text: string, index: number): string {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (HEADING.test(line)) return line.replace(/:$/, "").trim();
  }
  return "Document";
}

// ── Priming ─────────────────────────────────────────────────────────────────

const NUMERIC = /\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;
// Horizontal whitespace only: a proper noun must not span line breaks (\s would
// let one greedily swallow the next line).
const PROPER_NOUN = /[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+/g;
const IDENTIFIER = /\b(?:bar\s*(?:no\.?|number|#)?\s*\d{5,8}|case\s*(?:no\.?|#)?\s*[\w-]+|client\s*(?:id|no\.?|#)?\s*[\w-]+)\b/gi;
const FLAG = /\b(?:disput\w*|contest\w*|objection|conditional|anomal\w*|withheld|discrepanc\w*)\b/gi;

/**
 * Prime the VDB from normalized artifact text in a single pass. All extraction
 * happens here; no raw re-reads occur during the workflow.
 */
export async function primeVDB(
  artifactText: string,
  artifactHash: string,
  sessionId: string,
): Promise<VDBStore> {
  const entries: VDBEntry[] = [];
  let match: RegExpExecArray | null;

  // Numerics — every dollar amount, hour count, percentage.
  NUMERIC.lastIndex = 0;
  while ((match = NUMERIC.exec(artifactText)) !== null) {
    if (match[0] === "" ) { NUMERIC.lastIndex++; continue; }
    // Skip time/duration figures ("...within fourteen (14) days"). They are not
    // dollar amounts, and anchoring them as one poisons numeric validation.
    if (isDurationNumeric(artifactText, match.index + match[0].length)) continue;
    entries.push({
      type: "numeric",
      value: parseFloat(match[0].replace(/[$,]/g, "")),
      field: inferFieldContext(artifactText, match.index),
      section: inferSection(artifactText, match.index),
      position: match.index,
      confidence: 0.95,
    });
  }

  // Proper nouns — capitalized sequences (names, firms).
  PROPER_NOUN.lastIndex = 0;
  while ((match = PROPER_NOUN.exec(artifactText)) !== null) {
    entries.push({
      type: "proper_noun",
      value: match[0],
      field: inferFieldContext(artifactText, match.index),
      section: inferSection(artifactText, match.index),
      position: match.index,
      confidence: 0.8,
    });
  }

  // Identifiers — bar numbers, client IDs, case numbers.
  IDENTIFIER.lastIndex = 0;
  while ((match = IDENTIFIER.exec(artifactText)) !== null) {
    entries.push({
      type: "identifier",
      value: match[0].trim(),
      field: inferFieldContext(artifactText, match.index),
      section: inferSection(artifactText, match.index),
      position: match.index,
      confidence: 0.85,
    });
  }

  // Flags — dispute / conditional / anomaly language in prose.
  FLAG.lastIndex = 0;
  while ((match = FLAG.exec(artifactText)) !== null) {
    entries.push({
      type: "flag",
      value: match[0].toLowerCase(),
      field: inferFieldContext(artifactText, match.index),
      section: inferSection(artifactText, match.index),
      position: match.index,
      confidence: 0.7,
    });
  }

  return {
    sessionId,
    artifactHash,
    entries,
    primedAt: new Date().toISOString(),
  };
}

/** Query the primed store by entry type and optional inferred field. */
export function queryVDB(store: VDBStore, type: VDBEntry["type"], field?: string): VDBEntry[] {
  return store.entries.filter((e) => e.type === type && (!field || e.field === field));
}

/**
 * Overwrite the numeric anchor for a field with a human-confirmed value.
 *
 * After an officer restates a numeric field in the escalation dialog, that value
 * is authoritative — but the VDB was primed from the original extraction, which
 * may hold a stale or poisoned anchor for the field. Left in place, re-validation
 * would keep diffing the corrected payload against the old anchor and re-escalate
 * forever. This replaces every numeric entry for `field` with a single
 * full-confidence entry carrying the confirmed value, so re-validation compares
 * against what the human confirmed. Returns a new store; the input is untouched.
 */
export function setNumericAnchor(store: VDBStore, field: string, value: number): VDBStore {
  const others = store.entries.filter((e) => !(e.type === "numeric" && e.field === field));
  return {
    ...store,
    entries: [
      ...others,
      { type: "numeric", value, field, section: "Human correction", position: -1, confidence: 1 },
    ],
  };
}

/**
 * VDB integrity binding — the store is only valid while it matches the artifact
 * hash it was primed from. A mismatch means the source changed; the caller must
 * discard and re-prime.
 */
export function validateVDBIntegrity(vdb: VDBStore, currentArtifactHash: string): boolean {
  if (vdb.artifactHash !== currentArtifactHash) {
    console.warn("VDB invalidated — artifact hash mismatch");
    return false;
  }
  return true;
}
