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
