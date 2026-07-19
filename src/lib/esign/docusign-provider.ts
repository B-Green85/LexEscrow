/**
 * DocuSign implementation of `eSignProvider` (spec §20).
 *
 * A thin IPC shim, deliberately. Every credential-bearing operation — JWT
 * signing, token exchange, the REST calls themselves — happens in
 * `src-tauri/src/docusign.rs`. This class only marshals arguments across the
 * boundary, so the integration key and RSA private key never enter the WebView.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../backend";
import {
  EMBEDDED_RETURN_URL,
  toESignStatus,
  type ESignSigner,
  type ESignStatus,
  type eSignProvider,
} from "./types";

/** Thrown when the provider is used outside the desktop shell. */
export class TauriRequiredError extends Error {
  constructor() {
    super("DocuSign requires Tauri backend");
    this.name = "TauriRequiredError";
  }
}

function requireTauri(): void {
  if (!isTauri()) throw new TauriRequiredError();
}

export class DocuSignProvider implements eSignProvider {
  providerName(): string {
    return "DocuSign";
  }

  async sendEnvelope(
    sessionId: string,
    documentBytes: Uint8Array,
    documentLabel: string,
    signers: ESignSigner[],
    subject: string,
    message: string,
  ): Promise<string> {
    requireTauri();
    return invoke<string>("docusign_send_envelope", {
      // Tauri serializes Vec<u8> from a plain number array.
      documentBytes: Array.from(documentBytes),
      documentName: documentLabel,
      subject,
      message,
      signers,
      sessionId,
    });
  }

  async pollStatus(envelopeId: string): Promise<ESignStatus> {
    requireTauri();
    const raw = await invoke<string>("docusign_poll_status", { envelopeId });
    return toESignStatus(raw);
  }

  async getCertificate(envelopeId: string): Promise<Uint8Array> {
    requireTauri();
    const bytes = await invoke<number[]>("docusign_get_certificate", { envelopeId });
    return Uint8Array.from(bytes);
  }

  /**
   * Recipient view URL for an embedded signer (spec §22).
   *
   * The URL is single-use and expires in minutes, so it is fetched when the
   * signing window opens and never stored. `returnUrl` is fixed rather than a
   * parameter: it must match the loopback listener the backend actually runs,
   * and a caller-supplied value could only ever point somewhere that cannot
   * report completion.
   */
  async getEmbeddedSigningUrl(
    envelopeId: string,
    signerEmail: string,
    signerName: string,
    clientUserId: string,
  ): Promise<string> {
    requireTauri();
    return invoke<string>("docusign_get_embedded_signing_url", {
      envelopeId,
      signerEmail,
      signerName,
      clientUserId,
      returnUrl: EMBEDDED_RETURN_URL,
    });
  }
}
