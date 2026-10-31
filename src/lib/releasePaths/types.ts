// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Release-path domain types (spec §6 — Path B ArbitrationEscrow, Path C
 * StagedRelease).
 *
 * Money convention matches LexGuard's: every amount here is **integer cents as
 * `bigint`**. No floating-point arithmetic is ever performed on a financial
 * value. The Tauri IPC boundary cannot serialize `bigint`, so the row types in
 * `lib/backend.ts` carry `number` cents and are converted at the boundary —
 * these are the in-memory forms.
 */

export type MilestoneStatus =
  | "pending"
  | "submitted" // evidence submitted, awaiting review
  | "approved" // human authorized this milestone
  | "released" // funds released for this milestone
  | "disputed";

/** How a milestone's release condition is verified (spec §6 Stage 4). */
export type MilestoneConditionType = "document" | "time" | "event" | "manual";

export interface Milestone {
  id: string;
  label: string; // e.g. "Due diligence complete"
  description: string;
  amountCents: bigint; // partial amount to release
  conditionType: MilestoneConditionType;
  releaseDate?: string; // ISO date for time-based
  evidenceRequired?: string; // description of what to upload
  status: MilestoneStatus;
  submittedAt?: string;
  approvedAt?: string;
  releasedAt?: string;
  txHash?: string;
  evidenceHash?: string; // ArtifactGuard hash of evidence doc
}

export interface ArbitrationState {
  locked: boolean;
  lockedAt?: string;
  /**
   * `lockArbitration` transaction hash. Not persisted — derived
   * deterministically from the session id, so it survives a reload without a
   * schema column. Kept distinct from `resolutionTxHash`: the lock and the
   * release are two different on-chain events and the UI shows both.
   */
  lockTxHash?: string;
  arbiterAddress?: string; // third party arbiter wallet
  party1Signed: boolean;
  party2Signed: boolean;
  arbiterSigned: boolean;
  threshold: number; // default 2 (2-of-3)
  resolvedAt?: string;
  resolutionTxHash?: string;
  resolutionNotes?: string;
}

export interface StagedReleaseState {
  milestones: Milestone[];
  totalCents: bigint;
  releasedCents: bigint;
  remainingCents: bigint;
  currentMilestoneIndex: number;
  completedAt?: string;
}

/** What the milestone-definition form hands to `initStagedRelease`. */
export interface MilestoneInput {
  label: string;
  description: string;
  amountCents: bigint;
  conditionType: MilestoneConditionType;
  releaseDate?: string;
  evidenceRequired?: string;
}

/** Which of the three arbitration parties is casting a signature. */
export type ArbitrationSigner = "party1" | "party2" | "arbiter";

/** Default multi-sig threshold — 2-of-3 (spec §6 Path B, §10). */
export const DEFAULT_ARBITRATION_THRESHOLD = 2;

/** Ceiling on milestones per session, enforced by the definition form. */
export const MAX_MILESTONES = 10;
