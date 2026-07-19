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
import { descriptorFor, ASSET_CLASSES, type AssetClass } from "../lib/assetClasses";
import { CannaVerifyConditions } from "../components/CannaVerifyConditions";
import type { ESignEnvelope, ESignSigner, ESignStatus } from "../lib/esign";
import type { TrustAnchors } from "../lexguard/types";
import type { CannaVerifyConditions as CannaVerifyConditionsData } from "../lib/cannaverify/types";

// ── Signer derivation ────────────────────────────────────────────────────────

/**
 * Build the signer list from the trust anchors collected at Stage 1.
 *
 * Every asset class names its parties differently (buyer/seller,
 * licensee/licensor, client/law firm), so rather than hardcode seven shapes we
 * read the class's own anchor field definitions: each `email` field is paired
 * with the sibling `*Name` field sharing its prefix. Legal's
 * `clientFullLegalName` + `clientEmail` does not follow that convention, so the
 * class's declared primary party is used as the fallback pairing.
 */
export function deriveSigners(
  assetClass: AssetClass,
  anchors: TrustAnchors,
  rawAnchors: Record<string, string>,
): ESignSigner[] {
  const descriptor = ASSET_CLASSES[assetClass];
  const { primaryParty, primaryEmail } = descriptor.trustAnchorMap;
  const out: ESignSigner[] = [];
  const seen = new Set<string>();

  const push = (name: string, email: string, role: string) => {
    const key = email.trim().toLowerCase();
    if (!name.trim() || !key || seen.has(key)) return;
    seen.add(key);
    // Equal routing order → DocuSign sends to everyone at once. Escrow
    // signatures are peers, not a chain of approvals.
    out.push({ name: name.trim(), email: email.trim(), role, routingOrder: 1 });
  };

  for (const field of descriptor.anchorFields) {
    if (field.type !== "email") continue;
    const email = rawAnchors[field.key] ?? "";
    if (!email.trim()) continue;

    const prefix = field.key.replace(/Email$/i, "");
    const nameKey =
      [`${prefix}Name`, `${prefix}FullLegalName`, `${prefix}EntityName`].find(
        (k) => (rawAnchors[k] ?? "").trim().length > 0,
      ) ?? (field.key === primaryEmail ? primaryParty : undefined);

    const name = (nameKey && rawAnchors[nameKey]) || "";
    // `role` mirrors the class's own label for this party, e.g. "Buyer".
    const role = prefix.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
    push(name, email, role || "Signer");
  }

  // Fallback: the projected TrustAnchors always carry the primary party, even
  // when the raw record is empty (e.g. a session hydrated from a batch item).
  if (out.length === 0) {
    push(anchors.clientFullLegalName, anchors.clientEmail, descriptor.partyLabels[0]);
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
          <div className="text-sm font-semibold text-slate-800">{title}</div>
          <div className="mt-0.5 text-xs text-slate-400">{subtitle}</div>
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
      <span className="text-sm text-slate-500">{label}</span>
      <span
        className={`truncate text-sm text-slate-800 ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

// ── Envelope row ─────────────────────────────────────────────────────────────

function EnvelopeRow({ envelope }: { envelope: ESignEnvelope }) {
  const chip = STATUS_CHIP[envelope.status];
  return (
    <div className="rounded-lg border border-[#2D3A4A] bg-[#1A2435] px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium text-slate-800" title={envelope.documentLabel}>
          {envelope.documentLabel}
        </span>
        <span className={chip.cls}>{chip.text}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] text-slate-500">{envelope.envelopeId}</div>

      <ul className="mt-2 space-y-0.5">
        {envelope.signers.map((s) => (
          <li key={s.email} className="text-xs text-slate-500">
            {s.name} <span className="text-slate-400">· {s.role} · {s.email}</span>
          </li>
        ))}
      </ul>

      {envelope.status === "completed" && (
        <div className="mt-2.5 space-y-1 border-t border-[#2D3A4A] pt-2.5">
          {envelope.certificateHash && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-500">Certificate hash</span>
              <span className="font-mono text-[11px] text-slate-700" title={envelope.certificateHash}>
                {shortHash(envelope.certificateHash)}
              </span>
            </div>
          )}
          {envelope.onChainTx && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-500">AnchorReceipt</span>
              <a
                href={`https://sepolia.etherscan.io/tx/${envelope.onChainTx}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-[#93C5FD] hover:underline"
              >
                {envelope.onChainTx}
              </a>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500">Signer identity match</span>
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
        <p className="text-sm text-slate-500">
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
      <p className="text-sm text-slate-500">
        Condition verification via CRE adapter — V2 feature.
      </p>
      <ul className="mt-2 list-inside list-disc text-xs text-slate-400">
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
}

/** Store container — resolves state and hands it to the pure view. */
export function ConditionDefinition() {
  const {
    assetClass,
    artifact,
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
  } = useSession();

  return (
    <ConditionDefinitionView
      assetClass={assetClass}
      artifact={artifact}
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
    />
  );
}

export function ConditionDefinitionView({
  assetClass,
  artifact,
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
}: ConditionDefinitionViewProps) {
  const descriptor = descriptorFor(assetClass);
  const signers = useMemo(
    () => deriveSigners(assetClass, anchors, rawAnchors),
    [assetClass, anchors, rawAnchors],
  );

  const [releaseDate, setReleaseDate] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [subject, setSubject] = useState(
    `Signature required — ${descriptor.displayName} escrow release`,
  );
  const [message, setMessage] = useState(
    "Please review and sign the attached document to release the escrowed funds.",
  );

  const documentReady = !!artifact;
  const send = async () => {
    await onSendForSignature(artifact?.filename ?? "Escrow document", signers, subject, message);
    setDrawerOpen(false);
  };

  // V1 gate: at least one condition family configured. Loading a document
  // registers the ArtifactGuard baseline, so this is effectively always met —
  // the button exists to make the officer's confirmation an explicit,
  // auditable act rather than a silent pass-through.
  const canProceed =
    documentReady || releaseDate !== "" || eSignEnvelopes.length > 0;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-xl font-bold tracking-tight text-slate-900">
          <span aria-hidden>{descriptor.icon}</span>
          Condition Definition
        </h1>
        <span className="badge badge-brand">{descriptor.displayName}</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">
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
              : { cls: "badge badge-slate", text: "⏳ Pending" }
          }
        >
          {artifact ? (
            <div className="divide-y divide-slate-100">
              <Field label="Document" value={artifact.filename} />
              <Field label="AnchorReceipt hash" value={shortHash(artifact.hash)} mono />
              <Field label="Size" value={`${artifact.size.toLocaleString()} bytes`} />
            </div>
          ) : (
            <p className="text-sm text-slate-500">No document has been registered for this session.</p>
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
          subtitle="DocuSign eSignature — signers drawn from trust anchors"
          status={
            eSignEnvelopes.length === 0
              ? { cls: "badge badge-slate", text: "⏳ Not sent" }
              : eSignEnvelopes.every((e) => e.status === "completed")
                ? { cls: "badge badge-emerald", text: "✅ Signed" }
                : { cls: "badge badge-amber", text: "📤 In flight" }
          }
        >
          {signers.length === 0 ? (
            <p className="text-sm text-slate-500">
              No signer contact details were captured in the trust anchors for this session.
            </p>
          ) : (
            <>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Required signers
              </div>
              <ul className="mt-1.5 space-y-1">
                {signers.map((s) => (
                  <li key={s.email} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-slate-800">{s.name}</span>
                    <span className="truncate text-xs text-slate-500" title={s.email}>
                      {s.role} · {s.email}
                    </span>
                  </li>
                ))}
              </ul>

              {!drawerOpen ? (
                <button
                  className="btn btn-primary mt-4"
                  disabled={!documentReady || busy}
                  onClick={() => setDrawerOpen(true)}
                >
                  Send for Signature
                </button>
              ) : (
                <div className="mt-4 space-y-3 rounded-lg border border-[#2D3A4A] bg-[#1A2435] p-4">
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
                      {busy ? "Sending…" : `Send to ${signers.length} signer${signers.length > 1 ? "s" : ""}`}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setDrawerOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {eSignEnvelopes.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Envelopes
                </div>
                {eSignPolling && (
                  <span className="text-[11px] text-slate-500">Polling every 30s…</span>
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
        <p className="max-w-sm text-xs text-slate-400">
          Confirming moves this escrow to the monitor, where each condition is tracked live and
          settlement stays blocked until every one is met or waived.
        </p>
        <button className="btn btn-primary btn-lg" disabled={!canProceed || busy} onClick={onProceed}>
          Confirm Conditions &amp; Proceed to Escrow
        </button>
      </div>
    </div>
  );
}
