/**
 * Clio webhook integration (spec §14 V1).
 *
 * Posts matter-update notifications to Clio as an escrow moves through its
 * lifecycle, so a firm's practice-management system reflects the escrow without
 * anyone re-keying it. Outbound only: LexEscrow tells Clio what happened and
 * never asks Clio for anything, which keeps the integration from becoming a
 * dependency of the escrow flow itself.
 *
 * Clio names its events with a dotted, vendor-prefixed convention
 * (`lexescrow.settlement.complete`). PracticePanther does not — see
 * `practice-panther.ts` for the other half of the same idea.
 */

import { postWebhook, type WebhookResult } from "./transport";
import { sessionFacts } from "./session-facts";
import type { SessionState } from "../../store/session";

export interface ClioWebhookPayload {
  event: string;
  matterId?: string;
  sessionId: string;
  assetClass: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ClioConfig {
  webhookUrl: string;
  matterId?: string;
  apiKey?: string;
}

/** The six lifecycle events LexEscrow reports to Clio. */
export const CLIO_EVENTS = {
  sessionCreated: "lexescrow.session.created",
  reviewApproved: "lexescrow.review.approved",
  fundsDeposited: "lexescrow.funds.deposited",
  conditionsMet: "lexescrow.conditions.met",
  settlementComplete: "lexescrow.settlement.complete",
  receiptIssued: "lexescrow.receipt.issued",
} as const;

/** Connectivity probe fired by the Configuration screen's Test button. */
export const CLIO_TEST_EVENT = "lexescrow.test";

/**
 * Deliver one payload to Clio.
 *
 * `matterId` from the config fills in when the payload does not carry one — the
 * builder works from session state, which has no notion of a Clio matter, so
 * the association is made here at the point where the config is in hand.
 */
export async function sendClioWebhook(
  config: ClioConfig,
  payload: ClioWebhookPayload,
): Promise<WebhookResult> {
  const body: ClioWebhookPayload = {
    ...payload,
    ...(payload.matterId ?? config.matterId ? { matterId: payload.matterId ?? config.matterId } : {}),
  };
  return postWebhook(config.webhookUrl, body, config.apiKey);
}

/**
 * Project session state into a Clio payload.
 *
 * Everything in `data` comes from `sessionFacts`, the allowlist that keeps
 * wallet addresses and bar numbers out of outbound traffic. See
 * `session-facts.ts` for why the exclusion is built that way round.
 */
export function buildClioPayload(event: string, sessionState: SessionState): ClioWebhookPayload {
  const facts = sessionFacts(sessionState);
  const { sessionId, assetClass, ...data } = facts;
  return {
    event,
    sessionId,
    assetClass,
    timestamp: new Date().toISOString(),
    data,
  };
}
