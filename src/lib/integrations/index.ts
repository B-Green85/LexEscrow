// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Practice-management integrations barrel (spec §14 V1).
 *
 * One call site — `fireIntegrationWebhooks` — for the session store, so the
 * workflow does not have to know which integrations are configured or what each
 * vendor calls the event that just happened.
 */

import { buildClioPayload, sendClioWebhook, type ClioConfig } from "./clio-webhook";
import {
  buildPracticePantherPayload,
  sendPracticePantherWebhook,
  type PracticePantherConfig,
} from "./practice-panther";
import type { WebhookResult } from "./transport";
import type { SessionState } from "../../store/session";

export * from "./clio-webhook";
export * from "./practice-panther";
export { WEBHOOK_TIMEOUT_MS, type WebhookResult } from "./transport";
export { sessionFacts, type SessionFacts } from "./session-facts";

/**
 * The six lifecycle moments worth reporting, in LexEscrow's own vocabulary.
 * Each vendor's name for the event is derived from these.
 */
export const INTEGRATION_EVENTS = [
  "session.created",
  "review.approved",
  "funds.deposited",
  "conditions.met",
  "settlement.complete",
  "receipt.issued",
] as const;

export type IntegrationEvent = (typeof INTEGRATION_EVENTS)[number];

/**
 * Translate a LexEscrow event into each vendor's convention.
 *
 * Derived rather than table-driven: both vocabularies are total functions of
 * the canonical name, and a lookup table would just be a second place for the
 * six names to be spelled — one that could disagree with `CLIO_EVENTS` /
 * `PRACTICE_PANTHER_TRIGGERS` without anything noticing. A test pins the
 * derivation against those constants instead.
 */
export function clioEventName(event: string): string {
  return `lexescrow.${event}`;
}

export function practicePantherTriggerName(event: string): string {
  return `escrow_${event.replace(/\./g, "_")}`;
}

export interface IntegrationConfigs {
  clio?: ClioConfig;
  practicePanther?: PracticePantherConfig;
  /**
   * Optional delivery override.
   *
   * Under Tauri the API key is never handed to the WebView, so the configs
   * above arrive without one and this routes the POST through the Rust backend,
   * which supplies the credential from the vault. Left unset — in browser and
   * demo builds, and in tests — each adapter posts directly with the config it
   * was given.
   */
  transport?: (
    vendor: "clio" | "practicePanther",
    body: unknown,
  ) => Promise<WebhookResult>;
}

/**
 * Notify every configured integration that `event` occurred.
 *
 * Both webhooks are started before either is awaited, so a slow Clio endpoint
 * does not delay PracticePanther by its full ten-second timeout. `allSettled`
 * rather than `all`: one vendor being down must not suppress the other's
 * delivery, and neither failure is allowed to propagate — the escrow event
 * being reported has already happened, and no notification outcome can change
 * that.
 *
 * Failures are logged, not surfaced. The audit trail is the record of what the
 * escrow did; a webhook is a copy sent elsewhere, and a missing copy is an
 * operational problem rather than a legal one.
 */
export async function fireIntegrationWebhooks(
  event: string,
  sessionState: SessionState,
  configs: IntegrationConfigs,
): Promise<void> {
  const { transport } = configs;
  const sends: Promise<void>[] = [];

  if (configs.clio?.webhookUrl) {
    const config = configs.clio;
    const payload = buildClioPayload(clioEventName(event), sessionState);
    const delivery = transport
      ? transport("clio", { ...payload, ...(config.matterId && { matterId: config.matterId }) })
      : sendClioWebhook(config, payload);
    sends.push(
      delivery.then((r) => {
        if (!r.success) console.warn("Clio webhook failed", event, r.error ?? r.statusCode);
      }),
    );
  }

  if (configs.practicePanther?.webhookUrl) {
    const config = configs.practicePanther;
    const payload = buildPracticePantherPayload(practicePantherTriggerName(event), sessionState);
    const delivery = transport
      ? transport("practicePanther", {
          ...payload,
          ...(config.matterId && { matter_id: config.matterId }),
        })
      : sendPracticePantherWebhook(config, payload);
    sends.push(
      delivery.then((r) => {
        if (!r.success) {
          console.warn("PracticePanther webhook failed", event, r.error ?? r.statusCode);
        }
      }),
    );
  }

  if (sends.length === 0) return;
  await Promise.allSettled(sends);
}
