// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Path C — Staged Release (spec §6 Release Paths).
 *
 * Milestone-based transactions: partial fund release at each milestone
 * completion. Per spec, "each stage requires independent condition
 * verification and human authorization before release" — so approval and
 * release are two distinct steps here, never one. `approveMilestone` moves no
 * money; only `releaseMilestone` does, and it refuses to run on a milestone a
 * human has not approved.
 *
 * Money is integer cents as `bigint` throughout. The IPC boundary carries
 * `number` cents (Tauri cannot serialize bigint); conversion happens only at
 * that boundary, never mid-calculation.
 */

import * as backend from "../backend";
import { ExecutionPath } from "../../lexguard/types";
import {
  MAX_MILESTONES,
  type Milestone,
  type MilestoneInput,
  type MilestoneStatus,
  type StagedReleaseState,
} from "./types";

const LOG_OPERATOR = "paralegal@lawfirm.com";

const log = (
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
  operator: string = LOG_OPERATOR,
): Promise<unknown> => backend.logEvent(sessionId, event, operator, JSON.stringify(payload));

/** Deterministic stand-in for the `stagedDeposit` transaction hash. */
export function stagedDepositTx(sessionId: string): string {
  return `0xstaged-deposit-${sessionId.slice(-8)}`;
}

/** Deterministic stand-in for a `releaseMilestone` transaction hash. */
export function milestoneReleaseTx(milestoneId: string): string {
  return `0xmilestone-${milestoneId.slice(-8)}`;
}

function newMilestoneId(index: number): string {
  const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${index}`;
  return `ms-${index}-${rand}`;
}

/** DB row → in-memory milestone. Widens `number` cents back to `bigint`. */
function toMilestone(row: backend.MilestoneRow): Milestone {
  return {
    id: row.milestoneId,
    label: row.label,
    description: row.description,
    amountCents: BigInt(row.amountCents),
    conditionType: row.conditionType as Milestone["conditionType"],
    releaseDate: row.releaseDate ?? undefined,
    evidenceRequired: row.evidenceRequired ?? undefined,
    status: row.status as MilestoneStatus,
    submittedAt: row.submittedAt ?? undefined,
    approvedAt: row.approvedAt ?? undefined,
    releasedAt: row.releasedAt ?? undefined,
    txHash: row.txHash ?? undefined,
    evidenceHash: row.evidenceHash ?? undefined,
  };
}

/**
 * Derive the aggregate state from the milestone list.
 *
 * `currentMilestoneIndex` is the first milestone not yet released — the only
 * one the UI lets an operator act on, which is what makes the release strictly
 * sequential. It lands on `milestones.length` once every stage is done.
 */
function deriveState(milestones: Milestone[]): StagedReleaseState {
  const totalCents = milestones.reduce((sum, m) => sum + m.amountCents, 0n);
  const releasedCents = milestones
    .filter((m) => m.status === "released")
    .reduce((sum, m) => sum + m.amountCents, 0n);
  const firstUnreleased = milestones.findIndex((m) => m.status !== "released");
  const allReleased = milestones.length > 0 && firstUnreleased === -1;

  // Completion time is the last release, not "now" — re-deriving this state on
  // a later read must not move the timestamp.
  const completedAt = allReleased
    ? milestones.reduce<string | undefined>(
        (latest, m) => (m.releasedAt && (!latest || m.releasedAt > latest) ? m.releasedAt : latest),
        undefined,
      )
    : undefined;

  return {
    milestones,
    totalCents,
    releasedCents,
    remainingCents: totalCents - releasedCents,
    currentMilestoneIndex: allReleased ? milestones.length : Math.max(firstUnreleased, 0),
    completedAt,
  };
}

async function loadMilestones(sessionId: string): Promise<Milestone[]> {
  const rows = await backend.getMilestones(sessionId);
  return rows.map(toMilestone);
}

/** Re-read one milestone after a write, so callers always get persisted truth. */
async function reloadMilestone(sessionId: string, milestoneId: string): Promise<Milestone> {
  const found = (await loadMilestones(sessionId)).find((m) => m.id === milestoneId);
  if (!found) throw new Error(`Milestone ${milestoneId} not found in session ${sessionId}.`);
  return found;
}

/**
 * Define the milestone schedule and deposit the total.
 *
 * `totalCents` is the escrow amount the milestones must exactly exhaust —
 * a schedule that under- or over-allocates is rejected rather than silently
 * stranding or over-committing funds.
 */
export async function initStagedRelease(
  sessionId: string,
  milestones: MilestoneInput[],
  totalCents: bigint,
): Promise<StagedReleaseState> {
  if (milestones.length === 0) {
    throw new Error("A staged release needs at least one milestone.");
  }
  if (milestones.length > MAX_MILESTONES) {
    throw new Error(`A staged release supports at most ${MAX_MILESTONES} milestones.`);
  }
  if (milestones.some((m) => m.amountCents <= 0n)) {
    throw new Error("Every milestone must release a positive amount.");
  }

  const allocated = milestones.reduce((sum, m) => sum + m.amountCents, 0n);
  if (allocated !== totalCents) {
    const fmt = (c: bigint) => `$${(Number(c) / 100).toFixed(2)}`;
    throw new Error(
      `Milestone amounts must sum to the escrow total. Allocated ${fmt(allocated)} of ${fmt(totalCents)}.`,
    );
  }

  for (const [index, m] of milestones.entries()) {
    await backend.createMilestone({
      sessionId,
      milestoneId: newMilestoneId(index),
      label: m.label,
      description: m.description,
      amountCents: Number(m.amountCents),
      conditionType: m.conditionType,
      releaseDate: m.releaseDate ?? null,
      evidenceRequired: m.evidenceRequired ?? null,
      sortOrder: index,
    });
  }

  await backend.setExecutionPath(sessionId, ExecutionPath.StagedRelease);
  await backend.updateSessionState(sessionId, "FUNDED");

  const txHash = stagedDepositTx(sessionId);
  await log(sessionId, "staged_release_initiated", {
    execution_path: ExecutionPath.StagedRelease,
    tx_hash: txHash,
    milestone_count: milestones.length,
    total_usdc: Number(totalCents) / 100,
    milestones: milestones.map((m) => ({
      label: m.label,
      amount_usdc: Number(m.amountCents) / 100,
      condition_type: m.conditionType,
    })),
    block_timestamp: new Date().toISOString(),
  });

  return deriveState(await loadMilestones(sessionId));
}

/**
 * Attach evidence to a milestone (`pending` → `submitted`).
 *
 * The file is hashed through ArtifactGuard, so the evidence gets an integrity
 * baseline of its own — the same treatment the source document and the
 * DocuSign certificate receive.
 */
export async function submitMilestoneEvidence(
  sessionId: string,
  milestoneId: string,
  evidenceFile: File,
): Promise<Milestone> {
  const milestone = await reloadMilestone(sessionId, milestoneId);
  if (milestone.status === "released") {
    throw new Error(`Milestone "${milestone.label}" has already been released.`);
  }

  const bytes = new Uint8Array(await evidenceFile.arrayBuffer());
  const artifact = await backend.loadArtifact(evidenceFile.name, bytes);
  const submittedAt = new Date().toISOString();

  await backend.updateMilestoneStatus({
    milestoneId,
    status: "submitted",
    submittedAt,
    evidenceHash: artifact.hash,
  });

  await log(sessionId, "milestone_evidence_submitted", {
    milestone_id: milestoneId,
    label: milestone.label,
    filename: evidenceFile.name,
    evidence_hash: artifact.hash,
    size: bytes.length,
    block_timestamp: submittedAt,
  });

  return reloadMilestone(sessionId, milestoneId);
}

/**
 * Human authorization for one milestone (`submitted` → `approved`).
 *
 * Deliberately moves no money. Spec §6 Path C requires independent human
 * authorization per stage, and separating approval from release is what makes
 * that gate real rather than decorative.
 */
export async function approveMilestone(
  sessionId: string,
  milestoneId: string,
  operatorIdentity: string,
): Promise<Milestone> {
  const milestone = await reloadMilestone(sessionId, milestoneId);
  if (milestone.status !== "submitted") {
    throw new Error(
      `Milestone "${milestone.label}" must have evidence submitted before approval (currently ${milestone.status}).`,
    );
  }

  const approvedAt = new Date().toISOString();
  await backend.updateMilestoneStatus({ milestoneId, status: "approved", approvedAt });

  await log(
    sessionId,
    "milestone_approved",
    {
      milestone_id: milestoneId,
      label: milestone.label,
      amount_usdc: Number(milestone.amountCents) / 100,
      evidence_hash: milestone.evidenceHash ?? null,
      officer_identity: operatorIdentity,
      attestation: true,
      block_timestamp: approvedAt,
    },
    operatorIdentity,
  );

  return reloadMilestone(sessionId, milestoneId);
}

/**
 * Release one milestone's funds (`approved` → `released`).
 *
 * Requires a prior human approval. When the last milestone releases, the
 * session moves to EXECUTED — that transition is what the store watches to
 * fire the client notification.
 */
export async function releaseMilestone(
  sessionId: string,
  milestoneId: string,
  recipientAddress: string,
  operatorIdentity: string,
): Promise<Milestone> {
  const milestone = await reloadMilestone(sessionId, milestoneId);
  if (milestone.status !== "approved") {
    throw new Error(
      `Milestone "${milestone.label}" must be approved before funds are released (currently ${milestone.status}).`,
    );
  }

  const releasedAt = new Date().toISOString();
  const txHash = milestoneReleaseTx(milestoneId);
  await backend.updateMilestoneStatus({ milestoneId, status: "released", releasedAt, txHash });

  const milestones = await loadMilestones(sessionId);
  const state = deriveState(milestones);
  const complete = state.remainingCents === 0n && milestones.every((m) => m.status === "released");

  await log(
    sessionId,
    "milestone_released",
    {
      milestone_id: milestoneId,
      label: milestone.label,
      amount_usdc: Number(milestone.amountCents) / 100,
      recipient: recipientAddress,
      tx_hash: txHash,
      released_total_usdc: Number(state.releasedCents) / 100,
      remaining_usdc: Number(state.remainingCents) / 100,
      officer_identity: operatorIdentity,
      block_timestamp: releasedAt,
    },
    operatorIdentity,
  );

  if (complete) {
    await backend.updateSessionState(sessionId, "EXECUTED");
    await log(
      sessionId,
      "staged_release_completed",
      {
        milestone_count: milestones.length,
        total_released_usdc: Number(state.releasedCents) / 100,
        block_timestamp: releasedAt,
      },
      operatorIdentity,
    );
  }

  return milestones.find((m) => m.id === milestoneId)!;
}

export async function getStagedReleaseState(sessionId: string): Promise<StagedReleaseState | null> {
  const milestones = await loadMilestones(sessionId);
  return milestones.length === 0 ? null : deriveState(milestones);
}
