/**
 * Stage 4 — Condition Definition (spec §22).
 *
 * The screen that was missing between Parsed Output Review and Execution
 * Confirmation. It shows the four release-condition families LexEscrow models
 * and is where the escrow officer dispatches documents for signature.
 *
 *   1. Document-based  — the ArtifactGuard baseline registered at load.
 *   2. Time-based      — an optional earliest-release date.
 *   3. Multi-party     — DocuSign envelopes, live status, certificate + tx.
 *   4. Event-based     — asset-class specific (CannaVerify, bar verification).
 *
 * This screen *defines* conditions; it does not enforce them. Confirming here
 * hands off to the Escrow Monitor (Stage 6/7), which tracks each condition's
 * live status and holds the settlement gate closed until every one is met or
 * explicitly waived.
 */

import { useMemo, useState } from "react";
import { useSession } from "../store/session";
import { descriptorFor, ASSET_CLASSES, EMAIL_RE, type AssetClass } from "../lib/assetClasses";
import { CannaVerifyConditions } from "../components/CannaVerifyConditions";
import { EmbeddedSigningPanel } from "../components/EmbeddedSigningPanel";
import type {
  EmbeddedSigningTarget,
  ESignEnvelope,
  ESignSigner,
  ESignStatus,
} from "../lib/esign";
import type { TrustAnchors } from "../lexguard/types";
import type { CannaVerifyConditions as CannaVerifyConditionsData } from "../lib/cannaverify/types";
import { txUrl } from "../lib/explorer";
import type { ClioMatterPayload, IntakeSource } from "../lib/clio";

/** Re-exported so callers of this screen need only one import. */
export type { EmbeddedSigningTarget } from "../lib/esign";

// ── Signer derivation ────────────────────────────────────────────────────────

/**
 * A required signer plus its resolved delivery route. `mode` is decided on
 * Document Load: `"email"` when the officer entered an address (DocuSign emails
 * it), `"in_app"` when they marked the party to sign in-app. For an in-app
 * signer, `email` is a synthetic recipient id — the DocuSign layer needs a
 * unique email and `clientUserId`, but no message is ever delivered to it.
 */
export interface RequiredSigner extends ESignSigner {
  mode: "email" | "in_app";
}

const signerSlug = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "signer";

/**
 * Synthetic recipient id for an in-app signer. Deterministic, so the envelope
 * raised for the ceremony and the "signed in app" badge derive the same value.
 * No mail is delivered here — the address exists only to satisfy DocuSign's
 * per-recipient email + `clientUserId` requirement for embedded signing.
 */
export function syntheticSignerEmail(name: string, role: string): string {
  return `${signerSlug(name)}.${signerSlug(role)}@in-app.lexescrow.local`;
}

/**
 * Build the signer list from the manually-entered trust anchors (spec §23).
 *
 * Both parties of the class are required signers. Each routes by the choice the
 * officer made on Document Load: a valid email → DocuSign email; otherwise
 * in-app signing with a synthetic recipient id. Emails are never inferred from
 * the document — the AI extraction no longer captures them at all.
 */
export function deriveSigners(
  assetClass: AssetClass,
  anchors: TrustAnchors,
  rawAnchors: Record<string, string>,
): RequiredSigner[] {
  const descriptor = ASSET_CLASSES[assetClass];
  const out: RequiredSigner[] = [];
  const seen = new Set<string>();

  const push = (name: string, email: string, role: string, mode: "email" | "in_app") => {
    const key = email.trim().toLowerCase();
    if (!name.trim() || !key || seen.has(key)) return;
    seen.add(key);
    // Equal routing order → DocuSign sends to everyone at once. Escrow
    // signatures are peers, not a chain of approvals.
    out.push({ name: name.trim(), email: email.trim(), role, routingOrder: 1, mode });
  };

  const route = (name: string, role: string, email: string, inApp: boolean) => {
    if (!inApp && EMAIL_RE.test(email.trim())) {
      push(name, email.trim(), role, "email");
    } else {
      push(name, syntheticSignerEmail(name, role), role, "in_app");
    }
  };

  for (const s of descriptor.signers) {
    const name = (rawAnchors[s.nameKey] ?? "").trim();
    if (!name) continue; // no name → this party cannot be a signer yet
    route(name, s.role, rawAnchors[s.emailKey] ?? "", (rawAnchors[s.modeKey] ?? "") === "in_app");
  }

  // Fallback: a session hydrated from a batch item carries the projected
  // TrustAnchors but an empty raw record.
  if (out.length === 0 && anchors.clientFullLegalName.trim()) {
    route(
      anchors.clientFullLegalName,
      descriptor.partyLabels[0],
      (anchors.email ?? anchors.clientEmail ?? "").trim(),
      false,
    );
  }
  return out;
}

// ── Presentation helpers ─────────────────────────────────────────────────────

const STATUS_CHIP: Record<ESignStatus, { cls: string; text: string }> = {
  sent: { cls: "badge badge-brand", text: "📤 Sent" },
  delivered: { cls: "badge badge-amber", text: "📬 Delivered" },
  completed: { cls: "badge badge-emerald", text: "✅ Signed" },
  declined: { cls: "badge badge-red", text: "❌ Declined" },
  voided: { cls: "badge badge-slate", text: "🚫 Voided" },
};

function shortHash(h: string): string {
  const bare = h.replace(/^sha256:/, "");
  return bare.length <= 18 ? bare : `${bare.slice(0, 10)}…${bare.slice(-6)}`;
}

function ConditionCard({
  title,
  subtitle,
  status,
  children,
}: {
  title: string;
  subtitle: string;
  status: { cls: string; text: string };
  children?: React.ReactNode;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-text-primary">{title}</div>
          <div className="mt-0.5 text-xs text-text-muted">{subtitle}</div>
        </div>
        <span className={status.cls}>{status.text}</span>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-text-muted">{label}</span>
      <span
        className={`truncate text-sm text-text-primary ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

// ── Signer row ───────────────────────────────────────────────────────────────

/**
 * One required signer, with the single route decided on Document Load.
 *
 * There is no email-vs-in-app toggle here anymore: the choice was made when the
 * officer entered (or omitted) the party's email. A signer with an email gets a
 * DocuSign envelope emailed to that address; a signer marked in-app signs in
 * LexEscrow with no email sent. Both routes converge on the same envelope,
 * certificate, AnchorReceipt registration, and AnchorMatcher check.
 */
function SignerRow({
  signer,
  signedInApp,
  busy,
  preparing,
  canAct,
  onSendEmail,
  onSignHere,
}: {
  signer: RequiredSigner;
  signedInApp: boolean;
  busy: boolean;
  preparing: boolean;
  canAct: boolean;
  onSendEmail: () => void;
  onSignHere: () => void;
}) {
  const isEmail = signer.mode === "email";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
      <span className="min-w-0">
        <span className="text-text-primary">{signer.name}</span>{" "}
        <span className="truncate text-xs text-text-muted" title={isEmail ? signer.email : undefined}>
          · {signer.role} · {isEmail ? signer.email : "signs in-app"}
        </span>
      </span>

      {signedInApp ? (
        <span className="badge badge-emerald">✅ Signed in app</span>
      ) : isEmail ? (
        <button
          className="btn btn-secondary btn-sm shrink-0"
          disabled={!canAct || busy}
          onClick={onSendEmail}
          title={`Email a DocuSign envelope to ${signer.email}`}
        >
          Send Email
        </button>
      ) : (
        <button
          className="btn btn-primary btn-sm shrink-0"
          disabled={!canAct || busy || preparing}
          onClick={onSignHere}
          title={`Sign in LexEscrow as ${signer.name} — no email sent`}
        >
          {preparing ? "Opening…" : "Sign Here"}
        </button>
      )}
    </li>
  );
}

// ── Envelope row ─────────────────────────────────────────────────────────────

function EnvelopeRow({ envelope }: { envelope: ESignEnvelope }) {
  const chip = STATUS_CHIP[envelope.status];
  return (
    <div className="rounded-lg border border-app-border bg-app-input px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium text-text-primary" title={envelope.documentLabel}>
          {envelope.documentLabel}
        </span>
        <span className={chip.cls}>{chip.text}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] text-text-muted">{envelope.envelopeId}</div>

      <ul className="mt-2 space-y-0.5">
        {envelope.signers.map((s) => (
          <li key={s.email} className="text-xs text-text-muted">
            {s.name} <span className="text-text-muted">· {s.role} · {s.email}</span>
          </li>
        ))}
      </ul>

      {envelope.status === "completed" && (
        <div className="mt-2.5 space-y-1 border-t border-app-border pt-2.5">
          {envelope.certificateHash && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-text-muted">Certificate hash</span>
              <span className="font-mono text-[11px] text-text-primary" title={envelope.certificateHash}>
                {shortHash(envelope.certificateHash)}
              </span>
            </div>
          )}
          {envelope.onChainTx && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-text-muted">AnchorReceipt</span>
              <a
                href={txUrl(envelope.onChainTx)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-brand-fg hover:underline"
              >
                {envelope.onChainTx}
              </a>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-text-muted">Signer identity match</span>
            <span
              className={`text-[11px] font-medium ${
                envelope.anchorMatch ? "text-emerald-600" : "text-amber-600"
              }`}
            >
              {envelope.anchorMatch
                ? "✅ Matches trust anchors"
                : "⚠️ No anchor match — human review"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Event-based conditions, per asset class ──────────────────────────────────

function EventConditions({
  assetClass,
  barActive,
  cannaVerifyConditions,
  cannaVerifyRunning,
  onRunCannaVerify,
}: Pick<
  ConditionDefinitionViewProps,
  "assetClass" | "barActive" | "cannaVerifyConditions" | "cannaVerifyRunning" | "onRunCannaVerify"
>) {
  if (assetClass === "cannabis_ind") {
    return (
      <CannaVerifyConditions
        conditions={cannaVerifyConditions}
        running={cannaVerifyRunning}
        onRun={onRunCannaVerify}
      />
    );
  }

  if (assetClass === "legal") {
    return (
      <ConditionCard
        title="Event-based conditions"
        subtitle="California State Bar — attorney standing"
        status={
          barActive
            ? { cls: "badge badge-emerald", text: "✅ Verified" }
            : { cls: "badge badge-slate", text: "⏳ Not run" }
        }
      >
        <p className="text-sm text-text-muted">
          {barActive
            ? "Attorney bar number verified active with the California State Bar during processing."
            : "Attorney standing has not been verified for this session."}
        </p>
      </ConditionCard>
    );
  }

  return (
    <ConditionCard
      title="Event-based conditions"
      subtitle={`${descriptorFor(assetClass).displayName} regulatory verification`}
      status={{ cls: "badge badge-slate", text: "⏳ V2" }}
    >
      <p className="text-sm text-text-muted">
        Condition verification via CRE adapter — V2 feature.
      </p>
      <ul className="mt-2 list-inside list-disc text-xs text-text-muted">
        {descriptorFor(assetClass).releaseConditions.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </ConditionCard>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

/**
 * Everything the screen renders, as data. Kept separate from the store so the
 * view is a pure function of its props — which is also what makes it directly
 * renderable in tests without a DOM or a store harness.
 */
export interface ConditionDefinitionViewProps {
  assetClass: AssetClass;
  artifact: { filename: string; hash: string; size: number } | null;
  /**
   * Which intake produced the session. Optional, defaulting to the document
   * path, so every caller that predates Clio intake keeps its exact behavior.
   */
  intakeSource?: IntakeSource;
  /** The fetched matter, when the session came from Clio. */
  clioMatter?: ClioMatterPayload | null;
  anchors: TrustAnchors;
  rawAnchors: Record<string, string>;
  eSignEnvelopes: ESignEnvelope[];
  eSignPolling: boolean;
  busy: boolean;
  error: string | null;
  barActive: boolean | null;
  cannaVerifyConditions: CannaVerifyConditionsData | null;
  cannaVerifyRunning: boolean;
  onSendForSignature: (
    documentLabel: string,
    signers: ESignSigner[],
    subject: string,
    message: string,
  ) => Promise<void>;
  onRunCannaVerify: () => void;
  onProceed: () => void;
  /**
   * Raise an embedded envelope for one internal signer and return what the
   * signing panel needs. Optional so the view stays renderable — and testable —
   * without the store; absent, "Sign Here" is inert rather than missing, since
   * hiding the route entirely would misrepresent what the screen supports.
   */
  onSignInApp?: (signer: ESignSigner) => Promise<EmbeddedSigningTarget | null>;
  /** In-app signature collected — hand off to the certificate pipeline. */
  onEmbeddedSigningComplete?: (envelopeId: string, event: string) => void;
  /** Ceremony ended without a signature (cancelled, declined, timed out). */
  onEmbeddedSigningCancel?: (envelopeId: string) => void;
}

/** Store container — resolves state and hands it to the pure view. */
export function ConditionDefinition() {
  const {
    assetClass,
    artifact,
    intakeSource,
    clioMatter,
    anchors,
    rawAnchors,
    eSignEnvelopes,
    eSignPolling,
    sendForSignature,
    busy,
    error,
    barActive,
    cannaVerifyConditions,
    cannaVerifyRunning,
    runCannaVerify,
    navigateToEscrowMonitor,
    signInApp,
    completeEmbeddedSigning,
    cancelEmbeddedSigning,
  } = useSession();

  return (
    <ConditionDefinitionView
      assetClass={assetClass}
      artifact={artifact}
      intakeSource={intakeSource}
      clioMatter={clioMatter}
      anchors={anchors}
      rawAnchors={rawAnchors}
      eSignEnvelopes={eSignEnvelopes}
      eSignPolling={eSignPolling}
      busy={busy}
      error={error}
      barActive={barActive}
      cannaVerifyConditions={cannaVerifyConditions}
      cannaVerifyRunning={cannaVerifyRunning}
      onSendForSignature={sendForSignature}
      onRunCannaVerify={() => void runCannaVerify()}
      onProceed={() => navigateToEscrowMonitor()}
      onSignInApp={(signer) => signInApp(artifact?.filename ?? "Escrow document", signer)}
      onEmbeddedSigningComplete={(envelopeId, event) =>
        void completeEmbeddedSigning(envelopeId, event)
      }
      onEmbeddedSigningCancel={(envelopeId) => void cancelEmbeddedSigning(envelopeId)}
    />
  );
}

export function ConditionDefinitionView({
  assetClass,
  artifact,
  intakeSource = "artifact",
  clioMatter = null,
  anchors,
  rawAnchors,
  eSignEnvelopes,
  eSignPolling,
  busy,
  error,
  barActive,
  cannaVerifyConditions,
  cannaVerifyRunning,
  onSendForSignature,
  onRunCannaVerify,
  onProceed,
  onSignInApp,
  onEmbeddedSigningComplete,
  onEmbeddedSigningCancel,
}: ConditionDefinitionViewProps) {
  const descriptor = descriptorFor(assetClass);
  const signers = useMemo(
    () => deriveSigners(assetClass, anchors, rawAnchors),
    [assetClass, anchors, rawAnchors],
  );

  const [releaseDate, setReleaseDate] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** The open signing ceremony, if any. */
  const [signingTarget, setSigningTarget] = useState<EmbeddedSigningTarget | null>(null);
  /** Email of the signer whose envelope is being raised right now. */
  const [preparing, setPreparing] = useState<string | null>(null);

  /**
   * Who has already signed in-app. Derived from the envelopes rather than
   * tracked locally, so the badge reflects a completed certificate pipeline
   * and not merely a ceremony the officer walked through.
   */
  const signedInApp = useMemo(
    () =>
      new Set(
        eSignEnvelopes
          .filter((e) => e.embeddedSigning && e.status === "completed")
          .flatMap((e) => e.signers.map((s) => s.email.trim().toLowerCase())),
      ),
    [eSignEnvelopes],
  );

  const signHere = async (signer: ESignSigner) => {
    if (!onSignInApp) return;
    setPreparing(signer.email);
    try {
      const target = await onSignInApp(signer);
      if (target) setSigningTarget(target);
    } finally {
      setPreparing(null);
    }
  };
  const [subject, setSubject] = useState(
    `Signature required — ${descriptor.displayName} escrow release`,
  );
  const [message, setMessage] = useState(
    "Please review and sign the attached document to release the escrowed funds.",
  );

  const documentReady = !!artifact;
  /**
   * The Clio path's equivalent of "the intake is registered".
   *
   * Kept separate from `documentReady` rather than folded into it, because the
   * two are not interchangeable: `documentReady` also gates the signature
   * controls below, and there is genuinely no document to send for signature
   * here — `onSendForSignature` would dispatch a placeholder filename. Only the
   * proceed gate takes this as an alternative.
   */
  const clioIntakeReady = intakeSource === "clio" && !!clioMatter;
  // Only email-route signers are dispatched by the bulk send; in-app signers
  // sign per-row via "Sign Here".
  const emailSigners = useMemo(() => signers.filter((s) => s.mode === "email"), [signers]);
  const send = async () => {
    await onSendForSignature(artifact?.filename ?? "Escrow document", emailSigners, subject, message);
    setDrawerOpen(false);
  };

  // V1 gate: at least one condition family configured. Loading a document
  // registers the ArtifactGuard baseline, so this is effectively always met —
  // the button exists to make the officer's confirmation an explicit,
  // auditable act rather than a silent pass-through.
  //
  // A confirmed Clio matter satisfies the same gate. `artifact` is null on that
  // path by construction, so without this the officer could only proceed by
  // setting a release date or raising an envelope they did not want — the
  // document requirement reappearing one screen later in a different costume.
  const canProceed =
    documentReady || clioIntakeReady || releaseDate !== "" || eSignEnvelopes.length > 0;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-xl font-semibold text-text-primary">
          <span aria-hidden>{descriptor.icon}</span>
          Condition Definition
        </h1>
        <span className="badge badge-brand">{descriptor.displayName}</span>
      </div>
      <p className="mt-1 text-sm text-text-muted">
        Review the release conditions extracted from the document, collect any signatures required,
        and confirm before the escrow is funded.
      </p>

      <div className="mt-5 space-y-4">
        {/* 1 — Document-based */}
        <ConditionCard
          title="Document-based conditions"
          subtitle="ArtifactGuard integrity baseline"
          status={
            documentReady
              ? { cls: "badge badge-emerald", text: "✅ Registered" }
              : clioIntakeReady
                ? { cls: "badge badge-slate", text: "➖ Not applicable" }
                : { cls: "badge badge-slate", text: "⏳ Pending" }
          }
        >
          {artifact ? (
            <div className="divide-y divide-app-border">
              <Field label="Document" value={artifact.filename} />
              <Field label="AnchorReceipt hash" value={shortHash(artifact.hash)} mono />
              <Field label="Size" value={`${artifact.size.toLocaleString()} bytes`} />
            </div>
          ) : clioIntakeReady ? (
            // "Pending" would be a lie here, and a visible contradiction: the
            // proceed button below is enabled, and the checklist this screen
            // hands to Stage 7 already carries this condition as waived. Say
            // the same thing all three places.
            <div className="divide-y divide-app-border" data-testid="clio-intake-baseline">
              <Field label="Intake source" value="Clio Manage" />
              <Field label="Matter" value={clioMatter!.displayNumber} />
              <p className="pt-2 text-sm text-text-muted">
                Clio matter intake — document registration not applicable. The session is identified
                by its deterministic Clio intake identifier rather than an ArtifactGuard
                fingerprint.
              </p>
            </div>
          ) : (
            <p className="text-sm text-text-muted">No document has been registered for this session.</p>
          )}
        </ConditionCard>

        {/* 2 — Time-based */}
        <ConditionCard
          title="Time-based conditions"
          subtitle="Earliest permitted release date (optional)"
          status={
            releaseDate
              ? { cls: "badge badge-emerald", text: "✅ Set" }
              : { cls: "badge badge-slate", text: "⏳ Not set" }
          }
        >
          <label className="label" htmlFor="release-date">
            Release date
          </label>
          <input
            id="release-date"
            className="input"
            type="date"
            value={releaseDate}
            onChange={(e) => setReleaseDate(e.target.value)}
          />
        </ConditionCard>

        {/* 3 — Multi-party signature */}
        <ConditionCard
          title="Multi-party signature conditions"
          subtitle="DocuSign eSignature — email parties get an envelope; no-email parties sign in-app"
          status={
            eSignEnvelopes.length === 0
              ? { cls: "badge badge-slate", text: "⏳ Not sent" }
              : eSignEnvelopes.every((e) => e.status === "completed")
                ? { cls: "badge badge-emerald", text: "✅ Signed" }
                : { cls: "badge badge-amber", text: "📤 In flight" }
          }
        >
          {signers.length === 0 ? (
            <p className="text-sm text-text-muted">
              No signers could be derived — enter each party's name in the trust anchors first.
            </p>
          ) : (
            <>
              <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                Required signers
              </div>
              <p className="mt-0.5 text-[11px] text-text-muted">
                The route for each party was chosen on Document Load: an email address sends a
                DocuSign envelope; no email means the party signs in-app here.
              </p>
              <ul className="mt-1.5 divide-y divide-app-border">
                {signers.map((s) => (
                  <SignerRow
                    key={s.email}
                    signer={s}
                    signedInApp={signedInApp.has(s.email.trim().toLowerCase())}
                    busy={busy}
                    preparing={preparing === s.email}
                    canAct={documentReady && (s.mode === "email" || !!onSignInApp)}
                    onSendEmail={() =>
                      void onSendForSignature(
                        artifact?.filename ?? "Escrow document",
                        [s],
                        subject,
                        message,
                      )
                    }
                    onSignHere={() => void signHere(s)}
                  />
                ))}
              </ul>

              {emailSigners.length > 0 &&
                (!drawerOpen ? (
                  <button
                    className="btn btn-primary mt-4"
                    disabled={!documentReady || busy}
                    onClick={() => setDrawerOpen(true)}
                  >
                    Send for Signature ({emailSigners.length} via email)
                  </button>
                ) : (
                <div className="mt-4 space-y-3 rounded-lg border border-app-border bg-app-input p-4">
                  <div>
                    <label className="label" htmlFor="esign-subject">
                      Email subject
                    </label>
                    <input
                      id="esign-subject"
                      className="input"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="esign-message">
                      Message
                    </label>
                    <textarea
                      id="esign-message"
                      className="input min-h-20"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn btn-primary"
                      disabled={busy || !subject.trim()}
                      onClick={() => void send()}
                    >
                      {busy ? "Sending…" : `Send to ${emailSigners.length} signer${emailSigners.length > 1 ? "s" : ""}`}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setDrawerOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {eSignEnvelopes.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Envelopes
                </div>
                {eSignPolling && (
                  <span className="text-[11px] text-text-muted">Polling every 30s…</span>
                )}
              </div>
              {eSignEnvelopes.map((e) => (
                <EnvelopeRow key={e.envelopeId} envelope={e} />
              ))}
            </div>
          )}
        </ConditionCard>

        {/* 4 — Event-based (asset-class specific) */}
        <EventConditions
          assetClass={assetClass}
          barActive={barActive}
          cannaVerifyConditions={cannaVerifyConditions}
          cannaVerifyRunning={cannaVerifyRunning}
          onRunCannaVerify={onRunCannaVerify}
        />
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <p className="max-w-sm text-xs text-text-muted">
          Confirming moves this escrow to the monitor, where each condition is tracked live and
          settlement stays blocked until every one is met or waived.
        </p>
        <button className="btn btn-primary btn-lg" disabled={!canProceed || busy} onClick={onProceed}>
          Confirm Conditions &amp; Proceed to Escrow
        </button>
      </div>

      {signingTarget && (
        <EmbeddedSigningPanel
          envelopeId={signingTarget.envelopeId}
          signerEmail={signingTarget.signer.email}
          signerName={signingTarget.signer.name}
          clientUserId={signingTarget.clientUserId}
          onComplete={(event) => {
            setSigningTarget(null);
            onEmbeddedSigningComplete?.(signingTarget.envelopeId, event);
          }}
          onCancel={() => {
            setSigningTarget(null);
            onEmbeddedSigningCancel?.(signingTarget.envelopeId);
          }}
        />
      )}
    </div>
  );
}
