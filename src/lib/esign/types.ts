/**
 * Provider-agnostic eSignature contract (spec §20).
 *
 * DocuSign is implementation #1, not a hardcoded dependency — HelloSign and
 * Adobe Sign are V2 implementations of this same interface. Nothing above this
 * layer knows which provider is in play.
 */

export interface ESignSigner {
  name: string;
  email: string;
  role: string;
  routingOrder: number;
}

/**
 * DocuSign's envelope lifecycle, lowercased. `completed`, `declined` and
 * `voided` are terminal — polling stops there.
 */
export type ESignStatus = "sent" | "delivered" | "completed" | "declined" | "voided";

export const TERMINAL_STATUSES: readonly ESignStatus[] = ["completed", "declined", "voided"];

export function isTerminal(status: ESignStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * One envelope as LexEscrow tracks it. The last four fields are populated by
 * the completion pipeline (spec §23): ArtifactGuard hashes the certificate,
 * AnchorReceipt registers that hash on-chain, AnchorMatcher checks the signer
 * identities against the trust anchors collected at Stage 1.
 */
export interface ESignEnvelope {
  envelopeId: string;
  sessionId: string;
  documentLabel: string;
  signers: ESignSigner[];
  status: ESignStatus;
  sentAt: string;
  completedAt?: string;
  certificateHash?: string;
  onChainTx?: string;
  anchorMatch?: boolean;
}

export interface eSignProvider {
  providerName(): string;
  sendEnvelope(
    sessionId: string,
    documentBytes: Uint8Array,
    documentLabel: string,
    signers: ESignSigner[],
    subject: string,
    message: string,
  ): Promise<string>; // returns envelopeId
  pollStatus(envelopeId: string): Promise<ESignStatus>;
  getCertificate(envelopeId: string): Promise<Uint8Array>;
}

/**
 * Coerce an arbitrary provider status string into the union. DocuSign has
 * states beyond the five we model (`created`, `signed`, `correct`); anything
 * unrecognized is treated as still-in-flight rather than terminal, so an
 * unexpected value can never fulfill a condition by accident.
 */
export function toESignStatus(raw: string): ESignStatus {
  const s = raw.trim().toLowerCase();
  switch (s) {
    case "completed":
    case "declined":
    case "voided":
    case "delivered":
    case "sent":
      return s;
    case "signed":
      // A signed-but-not-finalized envelope is further along than "delivered"
      // but is not yet a completion — do not trigger the completion pipeline.
      return "delivered";
    default:
      return "sent";
  }
}
