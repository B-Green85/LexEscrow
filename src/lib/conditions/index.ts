/**
 * Condition tracking (spec §6 Stage 7) — public surface.
 *
 * The Escrow Monitor and the session store import from here; nothing outside
 * this directory should reach into `builder.ts` or `types.ts` directly.
 */

export * from "./types";
export {
  buildConditions,
  evaluateSummary,
  isDateReached,
  statusFromCannaVerify,
  statusFromESign,
  updateConditionFromCannaVerify,
  updateConditionFromESign,
  type BuildConditionsParams,
} from "./builder";
