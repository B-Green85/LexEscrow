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

import { EMBEDDED_RETURN_URL, type ESignSigner, type ESignStatus, type eSignProvider } from "./types";

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
    _clientUserId: string,
  ): Promise<string> {
    if (!this.envelopes.has(envelopeId)) {
      throw new Error(`Unknown envelope: ${envelopeId}`);
    }
    return `${EMBEDDED_RETURN_URL}?event=signing_complete&envelopeId=${encodeURIComponent(envelopeId)}`;
  }

  /** Test/demo helper — forget every tracked envelope. */
  reset(): void {
    this.envelopes.clear();
    this.seq = 0;
  }
}
