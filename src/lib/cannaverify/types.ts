/**
 * CannaVerify shared types (spec §5 — Cannabis Industry Context).
 *
 * CannaVerify is LexEscrow's CRE condition-verification adapter suite for the
 * Cannabis IND asset class. Each adapter wraps an external regulatory API
 * (Metrc, state cannabis authority, Secretary of State) as what will become a
 * Chainlink Functions call under CRE BFT consensus (spec §10). In this build
 * the calls hit the local mock Metrc adapter on port 3002. Attorney bar
 * verification has no mock — it goes to a real registry through the Rust
 * backend (`src-tauri/src/bar_verify.rs`).
 *
 * Every check result is persisted to the `cannaverify_results` table so the
 * on-chain record of due diligence survives the session.
 */

export type CannaVerifyCheckType =
  | "license_active"
  | "compliance_holds"
  | "inventory_confirmed"
  | "transfer_manifest"
  | "lab_results"
  | "entity_standing";

export type CannaVerifyResult = "PASS" | "FAIL" | "ERROR";

/** One regulatory condition evaluated against a live (here: mock) data source. */
export interface CannaVerifyCheck {
  checkType: CannaVerifyCheckType;
  metrcFacilityId?: string;
  stateLicenseNum?: string;
  result: CannaVerifyResult;
  detail: string; // human-readable result description
  onChainTx?: string; // CRE Functions tx hash (mock for now)
}

/** The full CannaVerify condition set for one escrow session. */
export interface CannaVerifyConditions {
  sessionId: string;
  stateLicenseNum: string;
  metrcFacilityId: string;
  licenseType: string;
  state: string; // 'CA' | 'CO' | 'MI' | 'IL' etc.
  inventorySchedule?: string[]; // batch numbers from parsed payload
  checks: CannaVerifyCheck[];
  overallResult: CannaVerifyResult;
  completedAt: string; // ISO timestamp
}

/** Human-readable label per check type — used by the condition checklist UI. */
export const CHECK_LABELS: Record<CannaVerifyCheckType, string> = {
  license_active: "License Active",
  compliance_holds: "Compliance Holds Clear",
  inventory_confirmed: "Inventory Confirmed",
  transfer_manifest: "Transfer Manifest",
  lab_results: "Lab Results",
  entity_standing: "Entity Standing",
};
