/**
 * PracticePanther webhook integration (spec §14 V1).
 *
 * The same lifecycle notifications as `clio-webhook.ts`, in PracticePanther's
 * vocabulary. The differences are not cosmetic and are why this is a separate
 * adapter rather than a `vendor` flag on one:
 *
 *   · the event field is named `trigger`, not `event`
 *   · triggers are flat snake_case (`escrow_settlement_complete`), not dotted
 *   · the envelope is snake_case throughout (`session_id`, `occurred_at`)
 *   · payload contents sit under `metadata`, not `data`
 *   · the sender identifies itself with an explicit `source` discriminator
 *
 * A single adapter parameterized over all five would be harder to read than two
 * that each say plainly what they send.
 */

import { postWebhook, type WebhookResult } from "./transport";
import { sessionFacts } from "./session-facts";
import type { SessionState } from "../../store/session";

export interface PracticePantherPayload {
  trigger: string;
  matter_id?: string;
  source: "lexescrow";
  session_id: string;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

export interface PracticePantherConfig {
  webhookUrl: string;
  matterId?: string;
  apiKey?: string;
}

/** The six lifecycle triggers, mirroring `CLIO_EVENTS`. */
export const PRACTICE_PANTHER_TRIGGERS = {
  sessionCreated: "escrow_session_created",
  reviewApproved: "escrow_review_approved",
  fundsDeposited: "escrow_funds_deposited",
  conditionsMet: "escrow_conditions_met",
  settlementComplete: "escrow_settlement_complete",
  receiptIssued: "escrow_receipt_issued",
} as const;

/** Connectivity probe fired by the Configuration screen's Test button. */
export const PRACTICE_PANTHER_TEST_TRIGGER = "escrow_test";

export async function sendPracticePantherWebhook(
  config: PracticePantherConfig,
  payload: PracticePantherPayload,
): Promise<WebhookResult> {
  const matterId = payload.matter_id ?? config.matterId;
  const body: PracticePantherPayload = {
    ...payload,
    ...(matterId ? { matter_id: matterId } : {}),
  };
  return postWebhook(config.webhookUrl, body, config.apiKey);
}

/**
 * Project session state into a PracticePanther payload.
 *
 * Draws on the same `sessionFacts` allowlist as the Clio builder, so both
 * integrations are subject to one exclusion policy rather than two that can
 * drift apart.
 */
export function buildPracticePantherPayload(
  trigger: string,
  sessionState: SessionState,
): PracticePantherPayload {
  const facts = sessionFacts(sessionState);
  const { sessionId, ...metadata } = facts;
  return {
    trigger,
    source: "lexescrow",
    session_id: sessionId,
    occurred_at: new Date().toISOString(),
    metadata,
  };
}
