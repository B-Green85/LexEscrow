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
  /**
   * Set only for *embedded* signers — internal parties (law firm staff, escrow
   * officer) who sign inside LexEscrow rather than through a DocuSign email.
   *
   * Its presence is what makes a recipient embedded: DocuSign sends them no
   * email and the ceremony is reachable only through a recipient view URL
   * minted against this exact id. External parties leave it undefined.
   */
  clientUserId?: string;
}

/**
 * Where DocuSign redirects the signing WebView when the ceremony ends. Served
 * by the loopback listener in `src-tauri/src/esign_callback.rs`, which turns
 * the redirect into an `esign:embedded_complete` event.
 *
 * The literal `127.0.0.1`, not `localhost`. The listener binds the IPv4
 * loopback only, while `localhost` resolves to `::1` first on a dual-stack
 * machine — a redirect there is refused, and a signature already collected
 * would reach the app only on the next 30-second poll.
 */
export const EMBEDDED_RETURN_URL = "http://127.0.0.1:55432/esign-complete";

/**
 * DocuSign's embedded-signing outcomes, as they arrive on the return URL.
 * Deliberately wider than {@link ESignStatus} — "declined" and "timed out" are
 * different facts about a signer and collapsing them loses the one an auditor
 * would ask about.
 */
export type EmbeddedSigningEvent =
  | "signing_complete"
  | "cancel"
  | "decline"
  | "session_timeout"
  | "ttl_expired"
  | "viewing_complete";

/** Payload of the `esign:embedded_complete` Tauri event. */
export interface EmbeddedSigningResult {
  envelopeId: string;
  event: string;
}

/**
 * What a "Sign Here" click resolves to: an envelope raised for embedded
 * signing, plus the client user ID it was created with. The signing panel needs
 * both, and DocuSign requires the id to match the envelope byte for byte.
 */
export interface EmbeddedSigningTarget {
  envelopeId: string;
  clientUserId: string;
  signer: ESignSigner;
}

/**
 * The embedded signer's id for an envelope.
 *
 * Deterministic on purpose. DocuSign requires the id used to request a
 * recipient view to be byte-identical to the one the recipient was created
 * with, and this is the single place both sides derive it — so envelope
 * creation and the view request cannot drift apart.
 */
export function embeddedClientUserId(operatorEmail: string, signerEmail: string): string {
  return `${operatorEmail.trim().toLowerCase()}-${signerEmail.trim().toLowerCase()}`;
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
  /** True when this envelope was raised for in-app (embedded) signing. */
  embeddedSigning?: boolean;
  /** Which internal party signs it in-app. */
  embeddedSignerName?: string;
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
  /**
   * Mint a signing-ceremony URL for an embedded signer.
   *
   * Optional: embedded signing is a DocuSign capability, not a universal one,
   * and a provider that cannot host a ceremony in-app should be unable to
   * claim it rather than obliged to throw. Callers must feature-detect.
   */
  getEmbeddedSigningUrl?(
    envelopeId: string,
    signerEmail: string,
    signerName: string,
    clientUserId: string,
  ): Promise<string>;
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
