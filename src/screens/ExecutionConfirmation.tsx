/**
 * Execution Confirmation — all three release paths (spec §6).
 *
 *   Path A — DirectSettlement  · CRE phase progression, then a settlement summary.
 *   Path B — ArbitrationEscrow · funds locked, 2-of-3 signature panel.
 *   Path C — StagedRelease     · milestone definition, then per-stage release.
 *
 * The three views share the settlement footer (audit chain + download + return
 * navigation) but nothing else — each path ends in a materially different
 * place, and collapsing them into one progress list would misrepresent Path B
 * and Path C as if they settle in a single step.
 *
 * Split into a store container and a pure `ExecutionConfirmationView`, matching
 * the Condition Definition screen: the view takes everything as props so it can
 * be render-tested without a live store.
 */

import { useEffect, useMemo, useState } from "react";
import { useSession, type ExecutionState } from "../store/session";
import { useBatch } from "../store/batch";
import { ExecutionPath } from "../lexguard/types";
import { formatUsd, toCents, toPayloadCents } from "../lexguard/payload-diff";
import * as backend from "../lib/backend";
import { CannaVerifyConditions } from "../components/CannaVerifyConditions";
import { AnchorReceiptCard } from "../components/AnchorReceiptCard";
import type { AnchorReceipt } from "../lib/anchor-receipt";
import type { AssetClass } from "../lib/assetClasses";
import type { CannaVerifyConditions as CannaVerifyConditionsData } from "../lib/cannaverify/types";
import { txUrl } from "../lib/explorer";
import {
  MAX_MILESTONES,
  type ArbitrationSigner,
  type ArbitrationState,
  type Milestone,
  type MilestoneConditionType,
  type MilestoneInput,
  type MilestoneStatus,
  type StagedReleaseState,
} from "../lib/releasePaths";

const PHASES: { key: string; label: string }[] = [
  { key: "verifying", label: "Verifying attorney & billing (Chainlink Functions)" },
  { key: "converting", label: "Converting USD → USDC (Chainlink Price Feeds)" },
  { key: "settling", label: "Executing settlement on-chain (CRE)" },
  { key: "notifying", label: "Notifying client" },
];

const CONDITION_TYPES: { value: MilestoneConditionType; label: string }[] = [
  { value: "manual", label: "Manual — officer confirms" },
  { value: "document", label: "Document — evidence uploaded" },
  { value: "time", label: "Time — on or after a date" },
  { value: "event", label: "Event — verified via CRE adapter" },
];

function shortRef(hash: string | null): string {
  if (!hash) return "—";
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/** Truncated, monospace tx reference linking out to Etherscan. */
function TxLink({ hash }: { hash: string | null }) {
  if (!hash) return <span className="font-mono text-sm text-slate-500">—</span>;
  return (
    <a
      className="font-mono text-sm text-brand-500 underline-offset-2 hover:underline"
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      data-selectable
    >
      {shortRef(hash)}
    </a>
  );
}

// ── Shared footer ────────────────────────────────────────────────────────────

/**
 * Audit-chain verification + report export. Identical across all paths.
 *
 * Two exports, because they serve different readers: the PDF is the human- and
 * counterparty-facing record (spec §14 V1), the JSON is the machine-readable
 * extract a verifier re-hashes. Neither is a substitute for the other.
 */
function AuditCard({
  onDownload,
  onPrintReport,
}: {
  onDownload: () => void;
  onPrintReport: () => void;
}) {
  const [chain, setChain] = useState<backend.ChainVerification | null>(null);

  useEffect(() => {
    backend.verifyAuditChain().then(setChain).catch(() => setChain(null));
  }, []);

  return (
    <div className="card mt-4 flex items-center justify-between gap-4 p-5">
      <div>
        <div className="text-sm font-semibold text-slate-700">Tamper-evident audit trail</div>
        <div className="mt-0.5 text-xs text-slate-500">
          {chain
            ? chain.valid
              ? `${chain.entries} entries · hash chain intact`
              : `chain broken at entry ${chain.brokenAt}`
            : "verifying…"}
          {chain?.valid && <span className="ml-1 text-emerald-600">✓</span>}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button className="btn btn-primary" onClick={onPrintReport}>
          Audit report (PDF)
        </button>
        <button className="btn btn-secondary" onClick={onDownload}>
          JSON
        </button>
      </div>
    </div>
  );
}

function FooterNav({
  fromBatch,
  onReset,
  onReturnToBatch,
}: {
  fromBatch: boolean;
  onReset: () => void;
  onReturnToBatch: () => void;
}) {
  return (
    <div className="mt-6 flex justify-center gap-2">
      {fromBatch ? (
        <button className="btn btn-primary" onClick={onReturnToBatch}>
          Back to batch
        </button>
      ) : (
        <button className="btn btn-secondary" onClick={onReset}>
          Start a new release
        </button>
      )}
    </div>
  );
}

function NotificationCard({ execution }: { execution: ExecutionState }) {
  if (execution.notifications.length === 0) return null;
  return (
    <div className="card mt-4 p-5">
      <div className="text-sm font-semibold text-slate-700">Client notification</div>
      <div className="mt-2 space-y-2">
        {execution.notifications.map((n, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="text-slate-500">
              {n.channel === "email" ? "Email" : "SMS"} · {n.target || "—"}
            </span>
            <span
              className={
                n.status === "delivered" || n.status === "sent"
                  ? "badge badge-emerald"
                  : n.status === "skipped"
                    ? "badge badge-slate"
                    : "badge badge-red"
              }
            >
              {n.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Path A — DirectSettlement (visually unchanged) ───────────────────────────

function DirectSettlementView({
  execution,
  cannaVerify,
  anchorReceipt,
  footer,
  onDownload,
  onPrintReport,
}: {
  execution: ExecutionState;
  cannaVerify: React.ReactNode;
  anchorReceipt: React.ReactNode;
  footer: React.ReactNode;
  onDownload: () => void;
  onPrintReport: () => void;
}) {
  const done = execution.phase === "done";
  const currentIndex = done ? PHASES.length : PHASES.findIndex((p) => p.key === execution.phase);

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          {done ? "Settlement complete" : "Executing settlement"}
        </h1>
        <span className="badge badge-brand">Path A — Direct Settlement</span>
      </div>

      {/* CRE progress */}
      <div className="card mt-5 divide-y divide-slate-100">
        {PHASES.map((p, i) => {
          const status = i < currentIndex ? "done" : i === currentIndex ? "active" : "pending";
          return (
            <div key={p.key} className="flex items-center gap-3 px-5 py-3.5">
              {status === "done" ? (
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                  </svg>
                </div>
              ) : status === "active" ? (
                <svg className="h-4 w-4 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
                </svg>
              ) : (
                <div className="h-5 w-5 rounded-full border-2 border-slate-200" />
              )}
              <span className={`text-sm ${status === "pending" ? "text-slate-400" : "text-slate-700"}`}>
                {p.label}
              </span>
            </div>
          );
        })}
      </div>

      {cannaVerify}

      {done && (
        <>
          <div className="card mt-5 p-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg bg-emerald-50 p-4">
                <div className="text-xs font-medium text-emerald-700">Released to client</div>
                <div className="mt-1 font-mono text-lg font-bold text-emerald-800">
                  {formatUsd(execution.clientCents)} USDC
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <div className="text-xs font-medium text-slate-600">Released to firm</div>
                <div className="mt-1 font-mono text-lg font-bold text-slate-800">
                  {formatUsd(execution.firmCents)} USDC
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
              <span className="text-sm text-slate-500">Settlement reference</span>
              <span className="font-mono text-sm text-slate-800" data-selectable>
                {shortRef(execution.txHash)}
              </span>
            </div>
          </div>

          {anchorReceipt}
          <NotificationCard execution={execution} />
          <AuditCard onDownload={onDownload} onPrintReport={onPrintReport} />
          {footer}
        </>
      )}
    </>
  );
}

// ── Path B — ArbitrationEscrow ───────────────────────────────────────────────

function SignatureRow({
  label,
  signed,
  onSign,
  disabled,
}: {
  label: string;
  signed: boolean;
  onSign: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3.5">
      <span className="flex items-center gap-2 text-sm text-slate-700">
        <span aria-hidden>{signed ? "✅" : "⬜"}</span>
        {label}
      </span>
      <span className="flex items-center gap-3">
        <span className={signed ? "badge badge-emerald" : "badge badge-slate"}>
          {signed ? "Signed" : "Pending"}
        </span>
        {/* Disabled once this party has signed — nobody signs twice. */}
        <button className="btn btn-secondary" onClick={onSign} disabled={signed || disabled}>
          Sign as {label}
        </button>
      </span>
    </div>
  );
}

function ArbitrationView({
  arbitrationState,
  execution,
  busy,
  error,
  onSign,
  cannaVerify,
  anchorReceipt,
  footer,
  onDownload,
  onPrintReport,
}: {
  arbitrationState: ArbitrationState | null;
  execution: ExecutionState;
  busy: boolean;
  error: string | null;
  onSign: (signer: ArbitrationSigner) => void;
  cannaVerify: React.ReactNode;
  anchorReceipt: React.ReactNode;
  footer: React.ReactNode;
  onDownload: () => void;
  onPrintReport: () => void;
}) {
  if (!arbitrationState) {
    return <div className="card p-6 text-sm text-slate-500">Locking escrow into arbitration…</div>;
  }

  const { party1Signed, party2Signed, arbiterSigned, threshold, resolvedAt, resolutionTxHash } =
    arbitrationState;
  const signed = [party1Signed, party2Signed, arbiterSigned].filter(Boolean).length;
  const resolved = Boolean(resolvedAt);

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          ⚖️ Arbitration Escrow — {resolved ? "Resolved" : "Funds Locked"}
        </h1>
        <span className="badge badge-amber">Path B — Arbitration Escrow</span>
      </div>

      {resolved && (
        <div className="card mt-5 border-emerald-500/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700">
            <span>✅ Arbitration Resolved —</span>
            <TxLink hash={resolutionTxHash ?? null} />
          </div>
          {arbitrationState.resolutionNotes && (
            <div className="mt-1 text-xs text-slate-500">{arbitrationState.resolutionNotes}</div>
          )}
        </div>
      )}

      {/* Lock state */}
      <div className="card mt-5 p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-500">Lock transaction</span>
          <TxLink hash={arbitrationState.lockTxHash ?? execution.txHash} />
        </div>
        {arbitrationState.arbiterAddress && (
          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
            <span className="text-sm text-slate-500">Arbiter</span>
            <span className="font-mono text-sm text-slate-700" data-selectable>
              {arbitrationState.arbiterAddress}
            </span>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
          <span className="text-sm text-slate-500">Locked in escrow</span>
          <span className="font-mono text-sm font-bold text-slate-800">
            {formatUsd(execution.clientCents)} USDC
          </span>
        </div>
      </div>

      {/* Multi-sig panel */}
      <div className="card mt-4">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <span className="text-sm font-semibold text-slate-700">Multi-signature resolution</span>
          <span className={signed >= threshold ? "badge badge-emerald" : "badge badge-amber"}>
            {signed}/{threshold} required signatures
          </span>
        </div>
        <div className="divide-y divide-slate-100">
          <SignatureRow
            label="Party 1"
            signed={party1Signed}
            disabled={busy || resolved}
            onSign={() => onSign("party1")}
          />
          <SignatureRow
            label="Party 2"
            signed={party2Signed}
            disabled={busy || resolved}
            onSign={() => onSign("party2")}
          />
          <SignatureRow
            label="Arbiter"
            signed={arbiterSigned}
            disabled={busy || resolved}
            onSign={() => onSign("arbiter")}
          />
        </div>
      </div>

      {error && <div className="mt-4 text-sm text-red-500">{error}</div>}

      {cannaVerify}

      {resolved && (
        <>
          {anchorReceipt}
          <NotificationCard execution={execution} />
          <AuditCard onDownload={onDownload} onPrintReport={onPrintReport} />
          {footer}
        </>
      )}
    </>
  );
}

// ── Path C — StagedRelease ───────────────────────────────────────────────────

interface MilestoneDraft {
  label: string;
  description: string;
  amount: string; // dollars, as typed
  conditionType: MilestoneConditionType;
  releaseDate: string;
  evidenceRequired: string;
}

function emptyDraft(): MilestoneDraft {
  return {
    label: "",
    description: "",
    amount: "",
    conditionType: "manual",
    releaseDate: "",
    evidenceRequired: "",
  };
}

/** Dollars typed into a text field → integer cents. Blank/garbage → 0. */
function draftCents(amount: string): bigint {
  const parsed = Number.parseFloat(amount.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? toCents(parsed) : 0n;
}

function MilestoneDefinitionForm({
  totalCents,
  busy,
  error,
  onInit,
}: {
  totalCents: bigint;
  busy: boolean;
  error: string | null;
  onInit: (milestones: MilestoneInput[]) => void;
}) {
  const [drafts, setDrafts] = useState<MilestoneDraft[]>([emptyDraft(), emptyDraft()]);

  const allocated = useMemo(
    () => drafts.reduce((sum, d) => sum + draftCents(d.amount), 0n),
    [drafts],
  );
  const remaining = totalCents - allocated;
  const balanced = remaining === 0n && allocated > 0n;
  const labelled = drafts.every((d) => d.label.trim().length > 0);
  const canSubmit = balanced && labelled && !busy;

  const patch = (index: number, next: Partial<MilestoneDraft>) =>
    setDrafts((rows) => rows.map((r, i) => (i === index ? { ...r, ...next } : r)));

  const onSubmit = () =>
    onInit(
      drafts.map((d) => ({
        label: d.label.trim(),
        description: d.description.trim() || d.label.trim(),
        amountCents: draftCents(d.amount),
        conditionType: d.conditionType,
        releaseDate: d.releaseDate.trim() || undefined,
        evidenceRequired: d.evidenceRequired.trim() || undefined,
      })),
    );

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">Define Release Milestones</h1>
        <span className="badge badge-brand">Path C — Staged Release</span>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        Partial release at each milestone. Every stage requires independent verification and human
        authorization before funds move — milestone amounts must exhaust the{" "}
        <span className="font-mono">{formatUsd(totalCents)}</span> escrow exactly.
      </p>

      <div className="mt-5 space-y-4">
        {drafts.map((d, i) => (
          <div key={i} className="card p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">Milestone {i + 1}</span>
              {drafts.length > 1 && (
                <button
                  className="btn btn-secondary"
                  onClick={() => setDrafts((rows) => rows.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className="label" htmlFor={`ms-label-${i}`}>
                  Label
                </label>
                <input
                  id={`ms-label-${i}`}
                  className="input"
                  value={d.label}
                  placeholder="Due diligence complete"
                  onChange={(e) => patch(i, { label: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor={`ms-amount-${i}`}>
                  Amount (USD)
                </label>
                <input
                  id={`ms-amount-${i}`}
                  className="input"
                  inputMode="decimal"
                  value={d.amount}
                  placeholder="2500.00"
                  onChange={(e) => patch(i, { amount: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor={`ms-type-${i}`}>
                  Condition type
                </label>
                <select
                  id={`ms-type-${i}`}
                  className="input"
                  value={d.conditionType}
                  onChange={(e) =>
                    patch(i, { conditionType: e.target.value as MilestoneConditionType })
                  }
                >
                  {CONDITION_TYPES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor={`ms-date-${i}`}>
                  Release date (optional)
                </label>
                <input
                  id={`ms-date-${i}`}
                  className="input"
                  type="date"
                  value={d.releaseDate}
                  onChange={(e) => patch(i, { releaseDate: e.target.value })}
                />
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor={`ms-evidence-${i}`}>
                  Evidence required (optional)
                </label>
                <input
                  id={`ms-evidence-${i}`}
                  className="input"
                  value={d.evidenceRequired}
                  placeholder="Signed diligence memo"
                  onChange={(e) => patch(i, { evidenceRequired: e.target.value })}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          className="btn btn-secondary"
          disabled={drafts.length >= MAX_MILESTONES}
          onClick={() => setDrafts((rows) => [...rows, emptyDraft()])}
        >
          Add Milestone
        </button>
        <span className="text-xs text-slate-500">
          {drafts.length}/{MAX_MILESTONES} milestones
        </span>
      </div>

      {/* Running allocation total */}
      <div className="card mt-4 p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">Allocated</span>
          <span className="font-mono font-bold text-slate-800">
            {formatUsd(allocated)} / {formatUsd(totalCents)}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="text-slate-500">Unallocated</span>
          <span className={`font-mono font-bold ${balanced ? "text-emerald-600" : "text-amber-600"}`}>
            {formatUsd(remaining)}
          </span>
        </div>
        {!balanced && (
          <div className="mt-2 text-xs text-amber-600">
            {remaining > 0n
              ? "Milestone amounts must account for the entire escrow before release can begin."
              : "Milestones allocate more than the escrow holds."}
          </div>
        )}
        {balanced && !labelled && (
          <div className="mt-2 text-xs text-amber-600">Every milestone needs a label.</div>
        )}
      </div>

      {error && <div className="mt-4 text-sm text-red-500">{error}</div>}

      <div className="mt-6 flex justify-center">
        <button className="btn btn-primary btn-lg" disabled={!canSubmit} onClick={onSubmit}>
          Initiate Staged Release
        </button>
      </div>
    </>
  );
}

const STATUS_BADGE: Record<MilestoneStatus, { className: string; icon: string; label: string }> = {
  pending: { className: "badge badge-slate", icon: "⏳", label: "Pending" },
  submitted: { className: "badge badge-brand", icon: "📋", label: "Submitted" },
  approved: { className: "badge badge-amber", icon: "✅", label: "Approved" },
  released: { className: "badge badge-emerald", icon: "💸", label: "Released" },
  disputed: { className: "badge badge-red", icon: "⚠️", label: "Disputed" },
};

function MilestoneCard({
  milestone,
  index,
  active,
  defaultRecipient,
  busy,
  onSubmitEvidence,
  onApprove,
  onRelease,
}: {
  milestone: Milestone;
  index: number;
  active: boolean;
  defaultRecipient: string;
  busy: boolean;
  onSubmitEvidence: (milestoneId: string, file: File) => void;
  onApprove: (milestoneId: string) => void;
  onRelease: (milestoneId: string, recipient: string) => void;
}) {
  const [recipient, setRecipient] = useState(defaultRecipient);
  const badge = STATUS_BADGE[milestone.status];

  return (
    <div className={`card p-5 ${active ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-700">
            {index + 1}. {milestone.label}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">{milestone.description}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-bold text-slate-800">
            {formatUsd(milestone.amountCents)}
          </div>
          <span className={`${badge.className} mt-1`}>
            {badge.icon} {badge.label}
          </span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span>Condition: {milestone.conditionType}</span>
        {milestone.releaseDate && <span>· Not before {milestone.releaseDate}</span>}
        {milestone.evidenceRequired && <span>· Evidence: {milestone.evidenceRequired}</span>}
      </div>

      {/* Actions — only the current milestone is interactive, so releases stay
          strictly sequential. */}
      {active && milestone.status === "pending" && (
        <div className="mt-3">
          <label className="label" htmlFor={`ms-file-${milestone.id}`}>
            Submit Evidence
          </label>
          <input
            id={`ms-file-${milestone.id}`}
            className="input"
            type="file"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onSubmitEvidence(milestone.id, file);
            }}
          />
        </div>
      )}

      {active && milestone.status === "submitted" && (
        <div className="mt-3 flex items-center justify-between">
          <span className="font-mono text-xs text-slate-500" data-selectable>
            {milestone.evidenceHash ?? "—"}
          </span>
          <button className="btn btn-primary" disabled={busy} onClick={() => onApprove(milestone.id)}>
            Approve Milestone
          </button>
        </div>
      )}

      {active && milestone.status === "approved" && (
        <div className="mt-3">
          <label className="label" htmlFor={`ms-recipient-${milestone.id}`}>
            Recipient address
          </label>
          <div className="flex gap-2">
            <input
              id={`ms-recipient-${milestone.id}`}
              className="input"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={busy || !recipient.trim()}
              onClick={() => onRelease(milestone.id, recipient)}
            >
              Release Funds
            </button>
          </div>
        </div>
      )}

      {milestone.status === "released" && (
        <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-500">
            Released {milestone.releasedAt ? new Date(milestone.releasedAt).toLocaleString() : "—"}
          </span>
          <TxLink hash={milestone.txHash ?? null} />
        </div>
      )}

      {milestone.status === "disputed" && (
        <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-red-500">
          ⚠️ Disputed — resolution required before this stage can release.
        </div>
      )}
    </div>
  );
}

function StagedReleaseView({
  stagedReleaseState,
  execution,
  escrowTotalCents,
  defaultRecipient,
  busy,
  error,
  onInit,
  onSubmitEvidence,
  onApprove,
  onRelease,
  cannaVerify,
  anchorReceipt,
  footer,
  onDownload,
  onPrintReport,
}: {
  stagedReleaseState: StagedReleaseState | null;
  execution: ExecutionState;
  escrowTotalCents: bigint;
  defaultRecipient: string;
  busy: boolean;
  error: string | null;
  onInit: (milestones: MilestoneInput[]) => void;
  onSubmitEvidence: (milestoneId: string, file: File) => void;
  onApprove: (milestoneId: string) => void;
  onRelease: (milestoneId: string, recipient: string) => void;
  cannaVerify: React.ReactNode;
  anchorReceipt: React.ReactNode;
  footer: React.ReactNode;
  onDownload: () => void;
  onPrintReport: () => void;
}) {
  if (!stagedReleaseState) {
    return (
      <MilestoneDefinitionForm
        totalCents={escrowTotalCents}
        busy={busy}
        error={error}
        onInit={onInit}
      />
    );
  }

  const { milestones, releasedCents, remainingCents, currentMilestoneIndex, totalCents } =
    stagedReleaseState;
  const complete = remainingCents === 0n;
  // Integer percentage — no float arithmetic on the money itself.
  const percent = totalCents > 0n ? Number((releasedCents * 100n) / totalCents) : 0;

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          {complete ? "Staged release complete" : "Staged release in progress"}
        </h1>
        <span className={complete ? "badge badge-emerald" : "badge badge-brand"}>
          Path C — Staged Release
        </span>
      </div>

      {/* Progress */}
      <div className="card mt-5 p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">Released</span>
          <span className="font-mono font-bold text-slate-800">
            {formatUsd(releasedCents)} of {formatUsd(totalCents)}
          </span>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200/20">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
          <span>
            {milestones.filter((m) => m.status === "released").length}/{milestones.length} milestones
          </span>
          <span>{formatUsd(remainingCents)} remaining</span>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {milestones.map((m, i) => (
          <MilestoneCard
            key={m.id}
            milestone={m}
            index={i}
            active={i === currentMilestoneIndex}
            defaultRecipient={defaultRecipient}
            busy={busy}
            onSubmitEvidence={onSubmitEvidence}
            onApprove={onApprove}
            onRelease={onRelease}
          />
        ))}
      </div>

      {error && <div className="mt-4 text-sm text-red-500">{error}</div>}

      {cannaVerify}

      {complete && (
        <>
          {anchorReceipt}
          <NotificationCard execution={execution} />
          <AuditCard onDownload={onDownload} onPrintReport={onPrintReport} />
          {footer}
        </>
      )}
    </>
  );
}

// ── Pure view ────────────────────────────────────────────────────────────────

export interface ExecutionConfirmationViewProps {
  execution: ExecutionState;
  assetClass: AssetClass;
  arbitrationState: ArbitrationState | null;
  stagedReleaseState: StagedReleaseState | null;
  escrowTotalCents: bigint;
  defaultRecipient: string;
  busy: boolean;
  error: string | null;
  fromBatch: boolean;
  cannaVerifyConditions: CannaVerifyConditionsData | null;
  cannaVerifyRunning: boolean;
  /** Portable receipt for the session document (spec §8). Null if none issued. */
  anchorReceipt: AnchorReceipt | null;
  onDownloadAnchorReceipt: () => void;
  onRunCannaVerify: () => void;
  onSignArbitration: (signer: ArbitrationSigner) => void;
  onInitStagedRelease: (milestones: MilestoneInput[]) => void;
  onSubmitEvidence: (milestoneId: string, file: File) => void;
  onApproveMilestone: (milestoneId: string) => void;
  onReleaseMilestone: (milestoneId: string, recipient: string) => void;
  onDownload: () => void;
  /** Printable audit report (spec §14 V1) — raises the browser print dialog. */
  onPrintReport: () => void;
  onReset: () => void;
  onReturnToBatch: () => void;
}

export function ExecutionConfirmationView(props: ExecutionConfirmationViewProps) {
  const {
    execution,
    assetClass,
    cannaVerifyConditions,
    cannaVerifyRunning,
    onRunCannaVerify,
    fromBatch,
    onReset,
    onReturnToBatch,
  } = props;

  // Cannabis IND regulatory state is carried through every path.
  const cannaVerify =
    assetClass === "cannabis_ind" ? (
      <CannaVerifyConditions
        conditions={cannaVerifyConditions}
        running={cannaVerifyRunning}
        onRun={onRunCannaVerify}
      />
    ) : null;

  const footer = (
    <FooterNav fromBatch={fromBatch} onReset={onReset} onReturnToBatch={onReturnToBatch} />
  );

  // Rendered inside each path's completion block, so the receipt appears only
  // once the transaction it attests to has actually finished.
  const anchorReceipt = props.anchorReceipt ? (
    <AnchorReceiptCard receipt={props.anchorReceipt} onDownload={props.onDownloadAnchorReceipt} />
  ) : null;

  return (
    <div className="mx-auto w-full max-w-2xl">
      {execution.path === ExecutionPath.ArbitrationEscrow ? (
        <ArbitrationView
          arbitrationState={props.arbitrationState}
          execution={execution}
          busy={props.busy}
          error={props.error}
          onSign={props.onSignArbitration}
          cannaVerify={cannaVerify}
          anchorReceipt={anchorReceipt}
          footer={footer}
          onDownload={props.onDownload}
          onPrintReport={props.onPrintReport}
        />
      ) : execution.path === ExecutionPath.StagedRelease ? (
        <StagedReleaseView
          stagedReleaseState={props.stagedReleaseState}
          execution={execution}
          escrowTotalCents={props.escrowTotalCents}
          defaultRecipient={props.defaultRecipient}
          busy={props.busy}
          error={props.error}
          onInit={props.onInitStagedRelease}
          onSubmitEvidence={props.onSubmitEvidence}
          onApprove={props.onApproveMilestone}
          onRelease={props.onReleaseMilestone}
          cannaVerify={cannaVerify}
          anchorReceipt={anchorReceipt}
          footer={footer}
          onDownload={props.onDownload}
          onPrintReport={props.onPrintReport}
        />
      ) : (
        <DirectSettlementView
          execution={execution}
          cannaVerify={cannaVerify}
          anchorReceipt={anchorReceipt}
          footer={footer}
          onDownload={props.onDownload}
          onPrintReport={props.onPrintReport}
        />
      )}
    </div>
  );
}

// ── Store container ──────────────────────────────────────────────────────────

export function ExecutionConfirmation() {
  const {
    execution,
    assetClass,
    arbitrationState,
    stagedReleaseState,
    payload,
    busy,
    error,
    fromBatch,
    activeBatchItemId,
    cannaVerifyConditions,
    cannaVerifyRunning,
    anchorReceipt,
    downloadAnchorReceipt,
    runCannaVerify,
    signArbitration,
    initStagedRelease,
    submitEvidence,
    approveMilestone,
    releaseMilestone,
    buildAuditReport,
    downloadAuditReport,
    sessionId,
    reset,
    returnToBatch,
  } = useSession();

  // Reflect a completed settlement back into the batch table (Settled + tx).
  const done = execution.phase === "done";
  useEffect(() => {
    if (done && activeBatchItemId && execution.txHash) {
      useBatch.getState().markSettled(activeBatchItemId, execution.txHash);
    }
  }, [done, activeBatchItemId, execution.txHash]);

  const onDownload = async () => {
    const json = await buildAuditReport();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lexescrow-audit-${sessionId ?? "session"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ExecutionConfirmationView
      execution={execution}
      assetClass={assetClass}
      arbitrationState={arbitrationState}
      stagedReleaseState={stagedReleaseState}
      escrowTotalCents={payload ? toPayloadCents(payload).totalHeldCents : 0n}
      defaultRecipient={payload?.clientWallet ?? ""}
      busy={busy}
      error={error}
      fromBatch={fromBatch}
      cannaVerifyConditions={cannaVerifyConditions}
      cannaVerifyRunning={cannaVerifyRunning}
      anchorReceipt={anchorReceipt}
      onDownloadAnchorReceipt={() => downloadAnchorReceipt()}
      onRunCannaVerify={() => void runCannaVerify()}
      onSignArbitration={(signer) => void signArbitration(signer)}
      onInitStagedRelease={(milestones) => void initStagedRelease(milestones)}
      onSubmitEvidence={(id, file) => void submitEvidence(id, file)}
      onApproveMilestone={(id) => void approveMilestone(id)}
      onReleaseMilestone={(id, recipient) => void releaseMilestone(id, recipient)}
      onDownload={onDownload}
      onPrintReport={() => void downloadAuditReport()}
      onReset={() => reset()}
      onReturnToBatch={() => returnToBatch()}
    />
  );
}
