/**
 * CannaVerify orchestrator (spec §5 — CannaVerify Adapter Suite).
 *
 * Runs the cannabis condition set against Metrc and the state regulatory
 * authority, persists every result to `cannaverify_results`, and collapses the
 * individual checks into one overall verdict the escrow officer can act on.
 *
 * Checks run **sequentially, not concurrently**. Under CRE each result informs
 * the next (a dead license makes the inventory query meaningless, and each call
 * is a separate Chainlink Functions round reaching BFT consensus before the next
 * begins). The mock runs fine sequentially and keeps the ordering deterministic.
 *
 * `on_chain_tx` is a mock CRE Functions tx hash in this build — real in V2.
 */

import * as backend from "../backend";
import { checkLicense } from "./metrc-license";
import { checkComplianceHolds } from "./metrc-compliance";
import { checkInventory } from "./metrc-inventory";
import { checkTransferManifest } from "./metrc-transfer";
import { checkEntityStanding } from "./entity-standing";
import type { CannaVerifyCheck, CannaVerifyConditions, CannaVerifyResult } from "./types";

export * from "./types";
export { checkLicense } from "./metrc-license";
export { checkComplianceHolds } from "./metrc-compliance";
export { checkInventory } from "./metrc-inventory";
export { checkTransferManifest } from "./metrc-transfer";
export { checkEntityStanding } from "./entity-standing";

export const DEFAULT_METRC_BASE_URL = "http://localhost:3002";

export interface RunCannaVerifyInput {
  sessionId: string;
  stateLicenseNum: string;
  metrcFacilityId: string;
  licenseType: string;
  state: string;
  inventorySchedule?: string[];
  metrcBaseUrl?: string;
}

/** Simulated CRE Chainlink Functions tx hash for one check. */
function mockOnChainTx(checkType: string): string {
  return `0xcannav-${checkType}-${Date.now().toString(16)}`;
}

/**
 * PASS only when every check passed. A single FAIL fails the set outright —
 * a failed regulatory condition is not something an ERROR elsewhere can excuse,
 * so FAIL outranks ERROR.
 */
function collapse(checks: CannaVerifyCheck[]): CannaVerifyResult {
  if (checks.some((c) => c.result === "FAIL")) return "FAIL";
  if (checks.some((c) => c.result === "ERROR")) return "ERROR";
  return "PASS";
}

export async function runCannaVerify(conditions: RunCannaVerifyInput): Promise<CannaVerifyConditions> {
  const {
    sessionId,
    stateLicenseNum,
    metrcFacilityId,
    licenseType,
    state,
    inventorySchedule,
    metrcBaseUrl = DEFAULT_METRC_BASE_URL,
  } = conditions;

  const checks: CannaVerifyCheck[] = [];

  // Persist as each check lands, so a mid-run failure still leaves a partial
  // regulatory record behind. A DB write must never sink the verification run.
  const record = async (check: CannaVerifyCheck): Promise<CannaVerifyCheck> => {
    const stamped: CannaVerifyCheck = { ...check, onChainTx: mockOnChainTx(check.checkType) };
    try {
      await backend.saveCannaverifyResult({
        verifyId: crypto.randomUUID(),
        sessionId,
        checkType: stamped.checkType,
        metrcFacilityId: stamped.metrcFacilityId ?? metrcFacilityId ?? null,
        stateLicenseNum: stamped.stateLicenseNum ?? stateLicenseNum ?? null,
        result: stamped.result,
        onChainTx: stamped.onChainTx ?? null,
      });
    } catch (e) {
      console.error("cannaverify persist failed", stamped.checkType, e);
    }
    checks.push(stamped);
    return stamped;
  };

  await record(await checkLicense(stateLicenseNum, metrcBaseUrl));
  await record(await checkComplianceHolds(stateLicenseNum, metrcBaseUrl));
  await record(await checkInventory(inventorySchedule ?? [], metrcBaseUrl));
  await record(await checkTransferManifest(metrcBaseUrl));
  await record(await checkEntityStanding(stateLicenseNum, metrcBaseUrl));

  return {
    sessionId,
    stateLicenseNum,
    metrcFacilityId,
    licenseType,
    state,
    inventorySchedule,
    checks,
    overallResult: collapse(checks),
    completedAt: new Date().toISOString(),
  };
}
