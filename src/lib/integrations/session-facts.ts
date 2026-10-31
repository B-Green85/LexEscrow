// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * The non-sensitive projection of session state — everything an outbound
 * integration is allowed to know.
 *
 * This is an **allowlist, deliberately**. Webhooks post to servers LexEscrow
 * does not control, over a network, into systems with their own logging and
 * their own breach surface. Building the payload by starting from the whole
 * session and removing sensitive keys would mean every field added to the store
 * later is exported by default until someone remembers to exclude it. Starting
 * from nothing and naming what may leave inverts that: a new field is private
 * unless a human adds it here.
 *
 * Specifically excluded, and never to be added:
 *   · wallet addresses  — `clientWallet`, `lawFirmWallet`
 *   · bar / license numbers — `attorneyBarNumber`, `rawAnchors.*LicenseNumber`
 *   · the whole `rawAnchors` record, which carries both across asset classes
 */

import { toPayloadCents } from "../../lexguard/payload-diff";
import type { SessionState } from "../../store/session";

/** Facts shared by both integrations' payload builders. */
export interface SessionFacts {
  sessionId: string;
  assetClass: string;
  operator: string;
  clientName: string;
  escrowAmountUsd: number;
  executionPath: string;
  documentHash: string;
  settlementTxHash?: string;
  anchorReceiptId?: string;
  conditions?: { total: number; met: number; pending: number; failed: number };
}

/** Escrow value in whole dollars, derived from the integer-cents payload. */
function escrowAmountUsd(state: SessionState): number {
  if (!state.payload) return 0;
  return Number(toPayloadCents(state.payload).totalHeldCents) / 100;
}

export function sessionFacts(state: SessionState): SessionFacts {
  const { conditionSummary } = state;
  return {
    sessionId: state.sessionId ?? "",
    assetClass: state.assetClass,
    operator: state.operator,
    clientName: state.anchors.clientFullLegalName,
    escrowAmountUsd: escrowAmountUsd(state),
    executionPath: state.execution.path ?? state.payload?.recommendedPath ?? "",
    documentHash: state.artifact?.hash ?? "",
    ...(state.execution.txHash && { settlementTxHash: state.execution.txHash }),
    ...(state.anchorReceipt && { anchorReceiptId: state.anchorReceipt.receiptId }),
    ...(conditionSummary.total > 0 && {
      conditions: {
        total: conditionSummary.total,
        met: conditionSummary.met,
        pending: conditionSummary.pending,
        failed: conditionSummary.failed,
      },
    }),
  };
}
