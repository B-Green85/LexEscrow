// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Path B — Arbitration Escrow (spec §6 Release Paths).
 *
 * Disputed conditions or amounts. The escrow total is locked in the contract
 * and released only on a multi-signature resolution — 2-of-3 by default
 * (client / firm / arbiter), matching `RetainerRelease.resolveArbitration`
 * on-chain.
 *
 * The on-chain calls are simulated here with deterministic mock hashes, the
 * same stand-in the CannaVerify and AnchorReceipt layers use in this build; the
 * DB tally is the source of truth for the UI. Every consequential step lands on
 * the hash-chained audit trail.
 */

import * as backend from "../backend";
import { ExecutionPath, type ParsedRetainerPayload } from "../../lexguard/types";
import { toPayloadCents } from "../../lexguard/payload-diff";
import {
  DEFAULT_ARBITRATION_THRESHOLD,
  type ArbitrationSigner,
  type ArbitrationState,
} from "./types";

/**
 * Audit identity for release-path events raised outside an explicit operator
 * context. Signature casting is attributed to the party, not the operator, so
 * the officer identity is the recording actor.
 */
const LOG_OPERATOR = "paralegal@lawfirm.com";

const log = (sessionId: string, event: string, payload: Record<string, unknown>): Promise<unknown> =>
  backend.logEvent(sessionId, event, LOG_OPERATOR, JSON.stringify(payload));

/** Deterministic stand-in for the `lockArbitration` transaction hash. */
export function arbitrationLockTx(sessionId: string): string {
  return `0xarb-lock-${sessionId.slice(-8)}`;
}

/** Deterministic stand-in for the `resolveArbitration` transaction hash. */
export function arbitrationResolveTx(sessionId: string): string {
  return `0xarb-resolve-${sessionId.slice(-8)}`;
}

/** DB row → in-memory state. `lockedAt` doubles as the lock flag. */
function toState(row: backend.ArbitrationRow): ArbitrationState {
  return {
    locked: row.lockedAt !== null,
    lockedAt: row.lockedAt ?? undefined,
    lockTxHash: row.lockedAt !== null ? arbitrationLockTx(row.sessionId) : undefined,
    arbiterAddress: row.arbiterAddress ?? undefined,
    party1Signed: row.party1Signed === 1,
    party2Signed: row.party2Signed === 1,
    arbiterSigned: row.arbiterSigned === 1,
    threshold: row.threshold,
    resolvedAt: row.resolvedAt ?? undefined,
    resolutionTxHash: row.resolutionTxHash ?? undefined,
    resolutionNotes: row.resolutionNotes ?? undefined,
  };
}

function signatureCount(s: Pick<ArbitrationState, "party1Signed" | "party2Signed" | "arbiterSigned">): number {
  return [s.party1Signed, s.party2Signed, s.arbiterSigned].filter(Boolean).length;
}

/**
 * Lock a session's escrow into arbitration.
 *
 * The session moves to FUNDED, not EXECUTED — Path B deliberately does not
 * settle on entry. Funds sit locked until the threshold is met.
 */
export async function initArbitration(
  sessionId: string,
  payload: ParsedRetainerPayload,
  arbiterAddress?: string,
): Promise<ArbitrationState> {
  const threshold = DEFAULT_ARBITRATION_THRESHOLD;
  await backend.createArbitration({ sessionId, arbiterAddress: arbiterAddress ?? null, threshold });
  await backend.setExecutionPath(sessionId, ExecutionPath.ArbitrationEscrow);
  await backend.updateSessionState(sessionId, "FUNDED");

  const lockedAt = new Date().toISOString();
  const txHash = arbitrationLockTx(sessionId);
  const cents = toPayloadCents(payload);

  await log(sessionId, "arbitration_locked", {
    execution_path: ExecutionPath.ArbitrationEscrow,
    tx_hash: txHash,
    arbiter_address: arbiterAddress ?? null,
    threshold,
    total_held_usdc: Number(cents.totalHeldCents) / 100,
    disputed_amount_usdc: Number(cents.disputedAmountCents) / 100,
    client_wallet: payload.clientWallet,
    firm_wallet: payload.lawFirmWallet,
    block_timestamp: lockedAt,
  });

  return {
    locked: true,
    lockedAt,
    lockTxHash: txHash,
    arbiterAddress,
    party1Signed: false,
    party2Signed: false,
    arbiterSigned: false,
    threshold,
  };
}

/**
 * Cast one party's signature on the release.
 *
 * Idempotent per party: a second signature from a party already recorded is
 * ignored rather than counted twice, mirroring the contract's
 * `disputeSignatures[hash][signer]` guard — without it, one party could reach
 * a 2-of-3 threshold alone.
 */
export async function signArbitrationRelease(
  sessionId: string,
  signer: ArbitrationSigner,
  notes?: string,
): Promise<{ resolved: boolean; txHash?: string }> {
  const row = await backend.getArbitration(sessionId);
  if (!row) {
    throw new Error(`No arbitration is locked for session ${sessionId}.`);
  }

  const state = toState(row);

  // Already resolved — replay the outcome instead of re-releasing funds.
  if (state.resolvedAt) {
    return { resolved: true, txHash: state.resolutionTxHash };
  }

  const alreadySigned =
    signer === "party1" ? state.party1Signed : signer === "party2" ? state.party2Signed : state.arbiterSigned;
  if (alreadySigned) {
    return { resolved: false };
  }

  const next = {
    party1Signed: state.party1Signed || signer === "party1",
    party2Signed: state.party2Signed || signer === "party2",
    arbiterSigned: state.arbiterSigned || signer === "arbiter",
  };

  await backend.updateArbitration({
    sessionId,
    party1Signed: signer === "party1" ? true : null,
    party2Signed: signer === "party2" ? true : null,
    arbiterSigned: signer === "arbiter" ? true : null,
  });

  const signed = signatureCount(next);
  if (signed < state.threshold) {
    await log(sessionId, "arbitration_signature_added", {
      signer,
      signatures: signed,
      threshold: state.threshold,
      notes: notes ?? null,
      block_timestamp: new Date().toISOString(),
    });
    return { resolved: false };
  }

  // Threshold met — release.
  const resolvedAt = new Date().toISOString();
  const txHash = arbitrationResolveTx(sessionId);
  await backend.updateArbitration({
    sessionId,
    resolvedAt,
    resolutionTxHash: txHash,
    resolutionNotes: notes ?? null,
  });
  await backend.updateSessionState(sessionId, "EXECUTED");

  await log(sessionId, "arbitration_resolved", {
    final_signer: signer,
    signatures: signed,
    threshold: state.threshold,
    tx_hash: txHash,
    resolution_notes: notes ?? null,
    block_timestamp: resolvedAt,
  });

  return { resolved: true, txHash };
}

export async function getArbitrationState(sessionId: string): Promise<ArbitrationState | null> {
  const row = await backend.getArbitration(sessionId);
  return row ? toState(row) : null;
}
