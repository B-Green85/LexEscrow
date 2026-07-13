/**
 * scope-guard — enforces field-access boundaries. AI is authorized to read and
 * populate exactly this set of fields for a retainer release workflow. Any
 * attempt to touch a field outside the set is a scope violation.
 */

export const AUTHORIZED_FIELDS: ReadonlySet<string> = new Set([
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
]);

/** Returns the subset of accessed fields that are NOT authorized. */
export function detectScopeViolation(accessedFields: string[]): string[] {
  return accessedFields.filter((f) => !AUTHORIZED_FIELDS.has(f));
}
