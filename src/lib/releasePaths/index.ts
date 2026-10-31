// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Release paths (spec §6).
 *
 *   Path A — DirectSettlement  · atomic dual transfer, lives in the session store
 *   Path B — ArbitrationEscrow · `./arbitration`
 *   Path C — StagedRelease     · `./staged`
 */

export * from "./types";
export {
  initArbitration,
  signArbitrationRelease,
  getArbitrationState,
  arbitrationLockTx,
  arbitrationResolveTx,
} from "./arbitration";
export {
  initStagedRelease,
  submitMilestoneEvidence,
  approveMilestone,
  releaseMilestone,
  getStagedReleaseState,
  stagedDepositTx,
  milestoneReleaseTx,
} from "./staged";
