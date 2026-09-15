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
   * The delivery route chosen for this party on Document Load. Optional here
   * and required on `RequiredSigner`: an envelope read back from the provider
   * carries recipients, not routes, so this is only known for signers the
   * officer routed. `"in_app"` is what causes a `clientUserId` to be minted.
   */
  mode?: "email" | "in_app";
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
}

/**
 * This recipient signs in-app.
 *
 * Derived, never stored: one envelope now carries both routes, so "is this
 * embedded" is a fact about a *recipient*, not about the envelope. The
 * `clientUserId` is the same thing DocuSign keys on, which keeps LexEscrow's
 * answer and DocuSign's from drifting apart.
 */
export function isEmbeddedSigner(signer: ESignSigner): boolean {
  return (signer.clientUserId ?? "").trim() !== "";
}

/** The envelope carries at least one in-app recipient. */
export function hasEmbeddedSigner(envelope: { signers: ESignSigner[] }): boolean {
  return envelope.signers.some(isEmbeddedSigner);
}

/**
 * One recipient's routing state, as LexEscrow models it.
 *
 * `status` is DocuSign's recipient status lowercased. The one that matters is
 * the difference between `created` — the recipient exists but their routing
 * order has not been reached — and `sent`/`delivered`, which mean the document
 * is with them now.
 */
export interface ESignRecipientStatus {
  email: string;
  routingOrder: number;
  status: string;
  clientUserId?: string;
}

/**
 * The recipient may sign right now.
 *
 * `created` is the waiting state: DocuSign refuses a recipient view for such a
 * signer with `RECIPIENT_NOT_IN_SEQUENCE`, so this is precisely the condition
 * that gates the in-app "Sign Here" control.
 */
export function isRecipientActive(recipient: ESignRecipientStatus): boolean {
  const s = recipient.status.trim().toLowerCase();
  return s === "sent" || s === "delivered" || s === "autoresponded";
}

/** DocuSign's refusal when a recipient's routing turn has not yet arrived. */
export const RECIPIENT_NOT_IN_SEQUENCE = "RECIPIENT_NOT_IN_SEQUENCE";

/** What the officer is shown instead of DocuSign's raw 400 body. */
export const WAITING_FOR_OTHER_SIGNERS =
  "Waiting for other parties to sign before in-app signing is available.";

/**
 * Turn a recipient-view failure into something an officer can act on.
 *
 * The backend returns DocuSign's response body verbatim, which for an
 * out-of-sequence recipient is a JSON blob quoting `RECIPIENT_NOT_IN_SEQUENCE`.
 * That is the expected state of a correctly-built envelope whose earlier
 * signer has not finished — not an error the officer can do anything about
 * except wait — so it is translated rather than surfaced.
 */
export function describeRecipientViewError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes(RECIPIENT_NOT_IN_SEQUENCE)) return WAITING_FOR_OTHER_SIGNERS;
  return raw;
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
  /**
   * Per-recipient routing state.
   *
   * Optional for the same reason as {@link getEmbeddedSigningUrl}: it only
   * means anything to a provider that sequences recipients. Callers must
   * feature-detect and fall back to leaving in-app signing ungated.
   */
  listRecipients?(envelopeId: string): Promise<ESignRecipientStatus[]>;
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
