// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * anchor-matcher — verifies proper nouns and bar numbers extracted from the
 * document against user-provided trust anchors. Case-insensitive,
 * whitespace-normalized.
 */

/** Lowercase + collapse runs of whitespace to a single space + trim. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A duration unit (with an optional calendar/business/working modifier)
 * immediately following a numeric token, tolerating a closing paren and
 * whitespace — e.g. the ") days" in "fourteen (14) days".
 */
const DURATION_UNIT_AFTER =
  /^[\s)]*(?:(?:calendar|business|working)\s+)?(?:days?|weeks?|months?|years?)\b/i;

/**
 * Should a numeric token be excluded from dollar-amount candidate matching
 * because it is a time/duration figure rather than money?
 *
 * A termination clause like "return all unearned fees within fourteen (14) days"
 * puts a bare "14" beside money language; anchored as a $14 amount it poisons
 * numeric validation for whatever field the surrounding words imply — the
 * corrected payload never matches the stale anchor and the field re-escalates
 * forever. A token is a duration figure when a duration unit — day(s), week(s),
 * month(s), year(s) — follows it within the same clause (immediately, allowing a
 * closing paren, whitespace, or a calendar/business/working modifier).
 *
 * `tokenEnd` is the index just past the numeric token's digits.
 */
export function isDurationNumeric(text: string, tokenEnd: number): boolean {
  return DURATION_UNIT_AFTER.test(text.slice(tokenEnd, tokenEnd + 32));
}

/**
 * The client name extracted from the document must match the name entered at
 * document load (the ground-truth anchor).
 */
export function matchClientName(extracted: string, anchor: string): boolean {
  return normalizeName(extracted) === normalizeName(anchor);
}

/**
 * The bar number must agree across every source that has one:
 *   - the value the user entered,
 *   - the value Chainlink Functions verified against the CA State Bar,
 *   - the value AI extracted from the document (if present).
 *
 * If the document does not contain a bar number there is no conflict to flag,
 * so the user-provided ↔ Chainlink-verified agreement alone governs.
 */
export function matchBarNumber(
  extractedFromDoc: string | null,
  userProvided: string,
  chainlinkVerified: string,
): boolean {
  const digits = (s: string) => s.replace(/\s+/g, "").trim();
  const provided = digits(userProvided);
  const verified = digits(chainlinkVerified);
  if (provided !== verified) return false;
  if (!extractedFromDoc) return true; // not in the document — no conflict
  return digits(extractedFromDoc) === provided;
}
