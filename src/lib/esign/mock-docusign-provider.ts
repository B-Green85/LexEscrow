// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Mock eSign provider — demo mode and tests.
 *
 * Never touches Tauri or the network. Simulates the envelope lifecycle on a
 * compressed clock so a demo reaches "signed and verified" in half a minute
 * instead of waiting on a human:
 *
 *   0–10s   sent
 *   10–30s  delivered
 *   30s+    completed
 *
 * Each envelope carries its own creation timestamp, so several envelopes sent
 * at different moments advance independently — exactly as real ones would.
 */

import {
  EMBEDDED_RETURN_URL,
  RECIPIENT_NOT_IN_SEQUENCE,
  type ESignRecipientStatus,
  type ESignSigner,
  type ESignStatus,
  type eSignProvider,
} from "./types";

export const DEMO_ENVELOPE_PREFIX = "DEMO-ENV-";
export const DEMO_CERTIFICATE_TEXT = "DEMO-CERTIFICATE-PDF";

const DELIVERED_AFTER_MS = 10_000;
const COMPLETED_AFTER_MS = 30_000;

interface MockEnvelope {
  createdAt: number;
  sessionId: string;
  documentLabel: string;
  signers: ESignSigner[];
}

export class MockDocuSignProvider implements eSignProvider {
  private envelopes = new Map<string, MockEnvelope>();
  /** Disambiguates envelopes created within the same millisecond. */
  private seq = 0;

  providerName(): string {
    return "DocuSign (demo)";
  }

  async sendEnvelope(
    sessionId: string,
    _documentBytes: Uint8Array,
    documentLabel: string,
    signers: ESignSigner[],
    _subject: string,
    _message: string,
  ): Promise<string> {
    const now = Date.now();
    // Date.now() has millisecond resolution and fake timers make collisions
    // routine, so the sequence suffix guarantees a unique ID.
    const id = `${DEMO_ENVELOPE_PREFIX}${now}${this.seq === 0 ? "" : `-${this.seq}`}`;
    this.seq += 1;
    this.envelopes.set(id, { createdAt: now, sessionId, documentLabel, signers });
    return id;
  }

  async pollStatus(envelopeId: string): Promise<ESignStatus> {
    const env = this.envelopes.get(envelopeId);
    if (!env) throw new Error(`Unknown envelope: ${envelopeId}`);
    const age = Date.now() - env.createdAt;
    if (age >= COMPLETED_AFTER_MS) return "completed";
    if (age >= DELIVERED_AFTER_MS) return "delivered";
    return "sent";
  }

  async getCertificate(envelopeId: string): Promise<Uint8Array> {
    if (!this.envelopes.has(envelopeId)) {
      throw new Error(`Unknown envelope: ${envelopeId}`);
    }
    return new TextEncoder().encode(DEMO_CERTIFICATE_TEXT);
  }

  /**
   * A signing URL that *is* its own completion callback.
   *
   * The demo has no DocuSign ceremony to render, so the URL points straight at
   * the return endpoint carrying `signing_complete`. Opening it walks the exact
   * production path — loopback listener → `esign:embedded_complete` → the
   * certificate pipeline — with the human ceremony collapsed to zero, rather
   * than short-circuiting to a fake completion the real flow never takes.
   */
  async getEmbeddedSigningUrl(
    envelopeId: string,
    _signerEmail: string,
    _signerName: string,
    clientUserId: string,
  ): Promise<string> {
    const env = this.envelopes.get(envelopeId);
    if (!env) {
      throw new Error(`Unknown envelope: ${envelopeId}`);
    }
    // Refuse a signer whose turn has not arrived, in DocuSign's own words.
    // A mock that always hands back a URL would let the gating regress
    // silently — the failure it is there to prevent is exactly this one.
    const recipient = env.signers.find((s) => s.clientUserId === clientUserId);
    if (recipient && recipient.routingOrder > this.currentRoutingOrder(env)) {
      throw new Error(
        `DocuSign refused the embedded signing view (HTTP 400): {"errorCode":"${RECIPIENT_NOT_IN_SEQUENCE}","message":"The token for an out of sequence recipient cannot be generated."}`,
      );
    }
    return `${EMBEDDED_RETURN_URL}?event=signing_complete&envelopeId=${encodeURIComponent(envelopeId)}`;
  }

  /**
   * Which routing order currently holds the document.
   *
   * The compressed clock doubles as the routing clock: `sent` means the first
   * order still has it, `delivered` means the first order finished and the
   * document moved on, `completed` means everyone is done. That maps the one
   * distinction the UI depends on — waiting vs. able to sign — onto a
   * lifecycle the demo already simulates, rather than inventing a second one.
   */
  private currentRoutingOrder(env: MockEnvelope): number {
    const orders = env.signers.map((s) => s.routingOrder);
    const age = Date.now() - env.createdAt;
    return age >= DELIVERED_AFTER_MS ? Math.max(...orders) : Math.min(...orders);
  }

  async listRecipients(envelopeId: string): Promise<ESignRecipientStatus[]> {
    const env = this.envelopes.get(envelopeId);
    if (!env) throw new Error(`Unknown envelope: ${envelopeId}`);
    const age = Date.now() - env.createdAt;
    const current = this.currentRoutingOrder(env);

    return env.signers.map((s) => ({
      email: s.email,
      routingOrder: s.routingOrder,
      clientUserId: s.clientUserId,
      status:
        age >= COMPLETED_AFTER_MS || s.routingOrder < current
          ? "completed"
          : s.routingOrder === current
            ? "sent"
            : // Their turn has not come — DocuSign's own waiting state.
              "created",
    }));
  }

  /** Test/demo helper — forget every tracked envelope. */
  reset(): void {
    this.envelopes.clear();
    this.seq = 0;
  }
}
